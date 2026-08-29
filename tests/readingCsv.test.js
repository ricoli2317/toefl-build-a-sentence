const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseCsvDocument } = require("../lib/csv.ts");
const { adaptReadingCsv, readingCsvOccurrenceId } = require("../lib/reading/csvAdapter.ts");
const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const { buildReadingImportRows, importReadingPackageAtomic } = require("../lib/reading/importer.ts");
const {
  COMPLETE_THE_WORDS_HEADERS,
  READ_AN_ACADEMIC_PASSAGE_HEADERS,
  READ_IN_DAILY_LIFE_HEADERS
} = require("../lib/reading/csvSchemas.ts");
const { detectQuestionType } = require("../lib/questionCsvSchemas.ts");

const templateDir = path.join(__dirname, "../data/reading/csv-templates");
const material = {
  materialId: "RDL-001",
  title: "University Robotics Club Workshop",
  materialType: "flyer",
  source: "fixture",
  sourceDate: "2026-01-01",
  yearMonth: "2026-01",
  bindingStatus: "bound",
  imageAssetPath: "reading/rdl/RDL-001/material_final.png",
  hitboxDataPath: "reading/rdl/RDL-001/selection_map.json"
};

function template(file) {
  return parseCsvDocument(fs.readFileSync(path.join(templateDir, file), "utf8"), {
    trimValues: false
  });
}

function adapt(type, document, materials = new Map([[material.materialId, material]])) {
  return adaptReadingCsv({ type, rows: document.rows, sourceFile: "fixture.csv", materials });
}

test("teacher CSV detection recognizes the three fixed Reading headers", () => {
  assert.equal(detectQuestionType(COMPLETE_THE_WORDS_HEADERS), "complete_the_words");
  assert.equal(detectQuestionType(READ_IN_DAILY_LIFE_HEADERS), "read_in_daily_life");
  assert.equal(detectQuestionType(READ_AN_ACADEMIC_PASSAGE_HEADERS), "read_an_academic_passage");
  assert.equal(detectQuestionType([...READ_IN_DAILY_LIFE_HEADERS, "r2_url"]), "unknown");
});

test("CTW template reconstructs multiple paragraphs and slots as one item", () => {
  const result = adapt("complete_the_words", template("TOEFL_Complete_the_Words_TEMPLATE.csv"));
  assert.deepEqual(result.failures, []);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].questions[0].payload.paragraphs.length, 2);
  assert.equal(result.candidates[0].questions[0].payload.slots.length, 2);
});

test("CTW invalid slot reference rejects the complete occurrence", () => {
  const document = template("TOEFL_Complete_the_Words_TEMPLATE.csv");
  const passage = JSON.parse(document.rows[0].passage_json);
  passage[0].segments[1].slotId = "missing-slot";
  document.rows[0].passage_json = JSON.stringify(passage);
  const result = adapt("complete_the_words", document);
  assert.equal(result.candidates.length, 0);
  assert.match(result.failures[0].reason, /missing source reference|unknown slotId/);
});

test("RDL requires a known bound material with frozen object keys", () => {
  const document = template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  assert.equal(adapt("read_in_daily_life", document).candidates.length, 1);
  assert.match(adapt("read_in_daily_life", document, new Map()).failures[0].reason, /does not exist/);
  const pending = { ...material, bindingStatus: "pending", imageAssetPath: null, hitboxDataPath: null };
  assert.match(
    adapt("read_in_daily_life", document, new Map([[pending.materialId, pending]])).failures[0].reason,
    /not production-ready/
  );
  const urlMaterial = { ...material, imageAssetPath: "https://assets.example.com/material.png" };
  assert.match(
    adapt("read_in_daily_life", document, new Map([[urlMaterial.materialId, urlMaterial]])).failures[0].reason,
    /object key|object-key/
  );
});

test("RDL CSV requires the canonical material_type and rejects a mismatch", () => {
  const missing = template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  missing.rows.forEach((row) => { row.material_type = ""; });
  assert.match(adapt("read_in_daily_life", missing).failures[0].reason, /Missing material_type/);

  const mismatch = template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  mismatch.rows.forEach((row) => { row.material_type = "announcement"; });
  assert.match(adapt("read_in_daily_life", mismatch).failures[0].reason, /does not match canonical material/);
});

test("RDL CSV accepts only a saved canonical title of at most five English words", () => {
  const longTitle = "Extended Library Hours for Final Exams";
  const document = template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  document.rows.forEach((row) => { row.title = longTitle; });
  const longMaterial = { ...material, title: longTitle };
  const result = adapt("read_in_daily_life", document, new Map([[longMaterial.materialId, longMaterial]]));
  assert.equal(result.candidates.length, 0);
  assert.match(result.failures[0].reason, /1-5 English words/);
});

test("RDL CSV rejects noncanonical capitalization even when the title is short", () => {
  const title = "Gym membership";
  const document = template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv");
  document.rows.forEach((row) => { row.title = title; });
  const wrongCaseMaterial = { ...material, title };
  const result = adapt("read_in_daily_life", document, new Map([[wrongCaseMaterial.materialId, wrongCaseMaterial]]));
  assert.equal(result.candidates.length, 0);
  assert.match(result.failures[0].reason, /capitalize every English word/);
});

test("same RDL material with a different question group remains a possible duplicate", () => {
  const first = adapt("read_in_daily_life", template("TOEFL_Read_in_Daily_Life_TEMPLATE.csv")).candidates[0];
  const second = structuredClone(first);
  second.sourceOccurrenceId = "different-occurrence";
  second.source.sourceLabel = "EXAMPLE-20260812";
  second.source.occurrenceDate = "2026-08-12";
  second.source.yearMonth = "2026-08";
  second.questions[0].stem = "A meaningfully different question?";
  const grouped = groupReadingSourceOccurrences([first, second]);
  assert.equal(grouped.packages.length, 2);
  assert.equal(grouped.report.possibleDuplicates.length, 1);
});

test("RAP groups all supported question shapes and rejects conflicting passage rows", () => {
  const document = template("TOEFL_Read_an_Academic_Passage_TEMPLATE.csv");
  const valid = adapt("read_an_academic_passage", document);
  assert.equal(valid.candidates.length, 1);
  assert.deepEqual(valid.candidates[0].questions.map((question) => question.questionType), [
    "rap_multiple_choice",
    "rap_sentence_insertion",
    "rap_sentence_selection"
  ]);
  const conflict = structuredClone(document);
  const changed = JSON.parse(conflict.rows[1].passage_json);
  changed[0].sentences[0].text = "Conflicting text.";
  conflict.rows[1].passage_json = JSON.stringify(changed);
  const invalid = adapt("read_an_academic_passage", conflict);
  assert.equal(invalid.candidates.length, 0);
  assert.match(invalid.failures[0].reason, /passage_json conflicts/);
});

test("RAP keeps its complete original passage title even when it exceeds five words", () => {
  const document = template("TOEFL_Read_an_Academic_Passage_TEMPLATE.csv");
  const longTitle = "A Complete Academic Passage Title With Seven Words";
  document.rows.forEach((row) => { row.passage_title = longTitle; });
  const result = adapt("read_an_academic_passage", document);
  assert.deepEqual(result.failures, []);
  assert.equal(result.candidates[0].title, longTitle);
  assert.equal(result.candidates[0].passages[0].title, longTitle);
});

test("RAP invalid insertion answer and cross-paragraph sentence selection reject the group", () => {
  const insertion = template("TOEFL_Read_an_Academic_Passage_TEMPLATE.csv");
  insertion.rows[1].correct_anchor_id = "missing-anchor";
  assert.match(adapt("read_an_academic_passage", insertion).failures[0].reason, /invalid insertion answer|correctAnchorId/);

  const selection = template("TOEFL_Read_an_Academic_Passage_TEMPLATE.csv");
  selection.rows[2].correct_sentence_id = "missing-sentence";
  assert.match(
    adapt("read_an_academic_passage", selection).failures[0].reason,
    /missing source reference|correctSentenceId/
  );
});

test("stable source identity is filename-independent and duplicate upload is deterministic", () => {
  const identity = {
    type: "complete_the_words",
    sourceLabel: "7.5A",
    sourceModule: "m1",
    sourceOrder: 2,
    sourceGroupId: "g-2"
  };
  assert.equal(readingCsvOccurrenceId(identity), readingCsvOccurrenceId(identity));
  const document = template("TOEFL_Complete_the_Words_TEMPLATE.csv");
  const a = adaptReadingCsv({ type: identity.type, rows: document.rows, sourceFile: "a.csv" });
  const b = adaptReadingCsv({ type: identity.type, rows: document.rows, sourceFile: "renamed.csv" });
  assert.equal(a.candidates[0].sourceOccurrenceId, b.candidates[0].sourceOccurrenceId);
  assert.equal(
    groupReadingSourceOccurrences(a.candidates).packages[0].item.logicalItemId,
    groupReadingSourceOccurrences(b.candidates).packages[0].item.logicalItemId
  );
});

test("later and earlier exact occurrences stay one logical item and move first_seen backward", () => {
  const base = adapt("complete_the_words", template("TOEFL_Complete_the_Words_TEMPLATE.csv")).candidates[0];
  const july = structuredClone(base);
  july.sourceOccurrenceId = "july";
  july.source.sourceLabel = "7.5A";
  july.source.occurrenceDate = "2026-07-05";
  july.source.yearMonth = "2026-07";
  const august = structuredClone(base);
  august.sourceOccurrenceId = "august";
  august.source.sourceLabel = "8.12A";
  august.source.occurrenceDate = "2026-08-12";
  august.source.yearMonth = "2026-08";
  const june = structuredClone(base);
  june.sourceOccurrenceId = "june";
  june.source.sourceLabel = "6.20A";
  june.source.occurrenceDate = "2026-06-20";
  june.source.yearMonth = "2026-06";
  const grouped = groupReadingSourceOccurrences([july, august, june]);
  assert.equal(grouped.packages.length, 1);
  assert.equal(grouped.packages[0].occurrences.length, 3);
  assert.equal(grouped.packages[0].item.firstSeenDate, "2026-06-20");
  assert.equal("displayNumber" in grouped.packages[0].item, false);
});

test("atomic importer sends one complete package to one RPC", async () => {
  const packageData = groupReadingSourceOccurrences(
    adapt("complete_the_words", template("TOEFL_Complete_the_Words_TEMPLATE.csv")).candidates
  ).packages[0];
  let calls = 0;
  const supabase = {
    rpc: async (name, args) => {
      calls += 1;
      assert.equal(name, "import_reading_package_atomic");
      assert.equal(args.p_rows.reading_logical_items.length, 1);
      assert.equal(args.p_rows.reading_ctw_slots.length, 2);
      return { data: { inserted_question_count: 1, updated_question_count: 0 }, error: null };
    }
  };
  await importReadingPackageAtomic(supabase, packageData, { createdBy: "teacher" });
  assert.equal(calls, 1);
});

test("all three templates generate identical business keys on a second upload", () => {
  const cases = [
    ["complete_the_words", "TOEFL_Complete_the_Words_TEMPLATE.csv"],
    ["read_in_daily_life", "TOEFL_Read_in_Daily_Life_TEMPLATE.csv"],
    ["read_an_academic_passage", "TOEFL_Read_an_Academic_Passage_TEMPLATE.csv"]
  ];
  for (const [type, file] of cases) {
    const first = groupReadingSourceOccurrences(adapt(type, template(file)).candidates).packages[0];
    const second = groupReadingSourceOccurrences(adapt(type, template(file)).candidates).packages[0];
    assert.deepEqual(businessKeys(buildReadingImportRows(first)), businessKeys(buildReadingImportRows(second)));
  }
});

test("atomic migration is idempotent and preserves the earlier first-seen tuple", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../supabase/reading_csv_import.sql"), "utf8");
  assert.match(sql, /create or replace function public\.import_reading_package_atomic/);
  assert.match(sql, /on conflict \(logical_item_id\) do update/);
  assert.match(sql, /first_seen_date = excluded\.first_seen_date/);
  assert.match(sql, /numeric source-label/);
  assert.match(sql, /on conflict \(occurrence_id\) do update/);
  assert.match(sql, /on conflict \(occurrence_id, question_id\) do update/);
  assert.match(sql, /material_id, title, material_type, source/);
});

function businessKeys(rows) {
  const definitions = {
    reading_logical_items: ["logical_item_id"],
    reading_source_occurrences: ["occurrence_id"],
    reading_materials: ["material_id"],
    reading_passages: ["passage_id"],
    reading_passage_paragraphs: ["passage_id", "paragraph_id"],
    reading_passage_sentences: ["passage_id", "sentence_id"],
    reading_questions: ["question_id"],
    reading_question_options: ["question_id", "option_id"],
    reading_ctw_paragraphs: ["question_id", "paragraph_id"],
    reading_ctw_slots: ["question_id", "slot_id"],
    reading_ctw_segments: ["question_id", "paragraph_id", "segment_order"],
    reading_rap_insertion_anchors: ["question_id", "anchor_id"],
    reading_question_occurrences: ["occurrence_id", "question_id"]
  };
  return Object.fromEntries(Object.entries(definitions).map(([table, fields]) => [
    table,
    rows[table].map((row) => fields.map((field) => row[field]).join(":"))
  ]));
}
