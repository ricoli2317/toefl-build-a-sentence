const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const { ReadingValidationError, validateReadingImportPackage } = require("../lib/reading/validation.ts");
const { buildReadingImportRows, importReadingPackage } = require("../lib/reading/importer.ts");

const fixturePath = path.join(__dirname, "../data/reading/fixtures/reading-source.fixture.json");

function sourceFixture() {
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

function fixture(module) {
  const grouped = groupReadingSourceOccurrences(sourceFixture().occurrences);
  return structuredClone(grouped.packages.find((item) => item.item.module === module));
}

function expectInvalid(module, mutate, expectedText) {
  const input = fixture(module);
  mutate(input);
  assert.throws(
    () => validateReadingImportPackage(input),
    (error) => error instanceof ReadingValidationError
      && error.message.includes(expectedText)
      && error.message.includes(`item=${input.item.logicalItemId}`)
  );
}

test("groups the source fixture into CTW, RDL, and RAP logical practice items", () => {
  const grouped = groupReadingSourceOccurrences(sourceFixture().occurrences);
  assert.deepEqual(grouped.packages.map((item) => item.item.module), ["ctw", "rdl", "rap"]);
  assert.deepEqual(
    grouped.packages.flatMap((item) => item.questions.map((question) => question.questionType)),
    ["ctw", "rdl", "rap_multiple_choice", "rap_sentence_insertion", "rap_sentence_selection"]
  );
  grouped.packages.forEach(validateReadingImportPackage);
});

test("builds normalized rows while preserving authoritative text and occurrence history", () => {
  const ctw = fixture("ctw");
  const source = sourceFixture();
  source.occurrences.find((item) => item.module === "rap").questions[0].stem =
    "Keep THIS casing, commas, and wording—exactly!";
  const rap = groupReadingSourceOccurrences(source.occurrences).packages.find((item) => item.item.module === "rap");
  const ctwRows = buildReadingImportRows(ctw);
  const rapRows = buildReadingImportRows(rap);
  assert.equal(rapRows.reading_questions[0].stem, "Keep THIS casing, commas, and wording—exactly!");
  assert.equal(ctwRows.reading_ctw_slots.length, 3);
  assert.equal(ctwRows.reading_source_occurrences.length, 1);
  assert.equal(ctwRows.reading_question_occurrences.length, 1);
  assert.equal(rapRows.reading_rap_insertion_anchors.length, 4);
  assert.equal(rapRows.reading_passage_sentences.length, 5);
});

test("imports by stable logical/question/occurrence keys and remains idempotent", async () => {
  const stored = new Map();
  const upsertOptions = new Map();
  const database = {
    from(table) {
      return {
        select() {
          return {
            in(column, values) {
              const tableRows = stored.get(table) ?? new Map();
              return Promise.resolve({
                data: values.filter((value) => tableRows.has(value)).map((value) => ({ [column]: value })),
                error: null
              });
            }
          };
        },
        upsert(rows, options) {
          const { onConflict } = options;
          upsertOptions.set(table, options);
          const tableRows = stored.get(table) ?? new Map();
          const keys = onConflict.split(",");
          for (const row of rows) tableRows.set(keys.map((column) => row[column]).join("\u0000"), row);
          stored.set(table, tableRows);
          return Promise.resolve({ error: null });
        }
      };
    }
  };
  const input = fixture("rdl");
  const first = await importReadingPackage(database, input);
  const second = await importReadingPackage(database, input);
  assert.equal(first.insertedQuestionCount, 1);
  assert.equal(second.insertedQuestionCount, 0);
  assert.equal(second.updatedQuestionCount, 1);
  assert.equal(stored.get("reading_logical_items").size, 1);
  assert.equal(stored.get("reading_source_occurrences").size, 1);
  assert.equal(upsertOptions.get("reading_materials").ignoreDuplicates, true);
});

test("rejects CTW reconstruction and missing-length errors", () => {
  expectInvalid("ctw", (input) => { input.questions[0].payload.slots[0].missingText = "ationx"; }, "prefix + missingText");
  expectInvalid("ctw", (input) => { input.questions[0].payload.slots[1].missingLength = 3; }, "missingLength must equal");
  expectInvalid("ctw", (input) => { input.questions[0].payload.slots[1].slotId = input.questions[0].payload.slots[0].slotId; }, "duplicate slotId");
});

test("rejects invalid RDL answers and fake binding state", () => {
  expectInvalid("rdl", (input) => { input.questions[0].payload.correctOptionId = "missing-option"; }, "correctOptionId does not exist");
  expectInvalid("rdl", (input) => { input.materials[0].imageAssetPath = "/reading/not-verified.png"; }, "pending material paths must both be null");
  expectInvalid("rdl", (input) => { input.materials[0].bindingStatus = "bound"; }, "bound material requires");
});

test("rejects invalid RAP anchors and sentence-selection references", () => {
  expectInvalid("rap", (input) => {
    const question = input.questions.find((item) => item.questionType === "rap_sentence_insertion");
    question.payload.anchors[1].anchorId = question.payload.anchors[0].anchorId;
  }, "duplicate anchorId");
  expectInvalid("rap", (input) => {
    const question = input.questions.find((item) => item.questionType === "rap_sentence_selection");
    question.payload.correctSentenceId = "missing-sentence";
  }, "correctSentenceId does not exist");
});

test("rejects inconsistent occurrence mappings and first-seen metadata", () => {
  expectInvalid("rap", (input) => { input.occurrences[0].questionSources.pop(); }, "map every logical question");
  expectInvalid("rap", (input) => { input.item.firstSeenDate = "2026-07-01"; }, "first-seen fields");
  expectInvalid("ctw", (input) => { input.occurrences[0].questionSources[0].sourceQuestionEnd -= 1; }, "CTW source range");
});

test("migration defines logical items, structured occurrences, questions, constraints, indexes, and RLS", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../supabase/reading_data_layer.sql"), "utf8");
  for (const fragment of [
    "logical_item_id text primary key",
    "reading_source_occurrences",
    "reading_question_occurrences",
    "reading_passage_sentences",
    "reading_ctw_slots",
    "reading_rap_insertion_anchors",
    "unique (logical_item_id, question_order)",
    "foreign key (occurrence_id, logical_item_id)",
    "references public.reading_source_occurrences(occurrence_id, logical_item_id)",
    "foreign key (question_id, logical_item_id)",
    "references public.reading_questions(question_id, logical_item_id)",
    "enable row level security"
  ]) assert.ok(sql.includes(fragment), `missing migration fragment: ${fragment}`);
  assert.ok(!sql.includes("reading_sets"));
  assert.ok(!sql.includes("display_number"));
});
