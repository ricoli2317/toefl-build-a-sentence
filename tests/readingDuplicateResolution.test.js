const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseCsvDocument } = require("../lib/csv.ts");
const { adaptReadingCsv } = require("../lib/reading/csvAdapter.ts");
const {
  buildReadingDuplicateReviewPlans,
  resolveReadingDuplicateImports
} = require("../lib/reading/duplicateResolution.ts");
const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const { importReadingPackageAtomic } = require("../lib/reading/importer.ts");

const templateFile = path.join(
  __dirname,
  "../data/reading/csv-templates/TOEFL_Complete_the_Words_TEMPLATE.csv"
);

function basePackage() {
  const document = parseCsvDocument(fs.readFileSync(templateFile, "utf8"), { trimValues: false });
  const adapted = adaptReadingCsv({
    type: "complete_the_words",
    rows: document.rows,
    sourceFile: "fixture.csv"
  });
  assert.deepEqual(adapted.failures, []);
  return groupReadingSourceOccurrences(adapted.candidates).packages[0];
}

function incomingVariant(historical, suffix, answer) {
  const occurrence = historical.occurrences[0];
  const question = structuredClone(historical.questions[0]);
  question.logicalItemId = "temporary";
  question.questionId = `temporary-${suffix}`;
  const slot = question.payload.slots[0];
  const previousDisplayText = slot.displayText;
  slot.answer = `${slot.prefix}${answer}`;
  slot.missingText = answer;
  slot.missingLength = Array.from(answer).length;
  slot.displayText = `${slot.prefix}${"_".repeat(slot.missingLength)}`;
  const paragraph = question.payload.paragraphs.find((item) => item.paragraphId === slot.paragraphId);
  paragraph.rawText = paragraph.rawText.replace(previousDisplayText, slot.displayText);
  const candidate = {
    sourceOccurrenceId: `${occurrence.occurrenceId}-${suffix}`,
    module: historical.item.module,
    title: historical.item.title,
    source: {
      sourceKind: occurrence.sourceKind,
      sourceLabel: `9.${suffix}A`,
      occurrenceDate: `2026-09-${String(suffix).padStart(2, "0")}`,
      yearMonth: "2026-09",
      sourceQuestionFile: occurrence.sourceQuestionFile,
      sourceAnswerFile: occurrence.sourceAnswerFile,
      sourceModule: occurrence.sourceModule,
      sourceOrder: suffix,
      sourceQuestionStart: occurrence.sourceQuestionStart,
      sourceQuestionEnd: occurrence.sourceQuestionEnd
    },
    materials: [],
    passages: [],
    questions: [{
      ...question,
      sourceQuestionStart: occurrence.sourceQuestionStart,
      sourceQuestionEnd: occurrence.sourceQuestionEnd
    }]
  };
  return groupReadingSourceOccurrences([candidate]).packages[0];
}

function prepared(packageData, candidates = []) {
  return {
    packageData,
    existingItem: null,
    reuseKind: "new",
    batchSemanticReuseCount: 0,
    possibleDuplicateLogicalItemIds: candidates.map((candidate) => candidate.item.logicalItemId),
    possibleDuplicateCandidates: candidates,
    dataQualityWarning: null,
    historicalDuplicateLogicalItemIds: [],
    materialMatchKind: "not_applicable",
    addedOccurrenceCount: packageData.occurrences.length,
    occurrenceConflict: null
  };
}

test("Reading possible duplicate becomes one actionable review with a stable candidate", () => {
  const historical = basePackage();
  const incoming = incomingVariant(historical, 1, "changed-answer");
  const item = prepared(incoming, [historical]);
  const reviews = buildReadingDuplicateReviewPlans([item], []);

  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].pendingId, `reading-duplicate:${incoming.item.logicalItemId}`);
  assert.equal(reviews[0].incoming, item);
  assert.deepEqual(reviews[0].candidates.map((candidate) => candidate.item.logicalItemId), [
    historical.item.logicalItemId
  ]);
});

test("Reading final resolution refuses unresolved and forged candidate choices", () => {
  const historical = basePackage();
  const incoming = incomingVariant(historical, 2, "changed-answer-two");
  const item = prepared(incoming, [historical]);
  const reviews = buildReadingDuplicateReviewPlans([item], []);

  assert.throws(
    () => resolveReadingDuplicateImports([item], reviews, new Map()),
    /尚未处理/
  );
  assert.throws(
    () => resolveReadingDuplicateImports([item], reviews, new Map([[
      reviews[0].pendingId,
      { pendingId: reviews[0].pendingId, action: "reuse_existing", candidateLogicalItemId: "forged" }
    ]])),
    /无效的候选题/
  );
});

test("manual reuse keeps the historical logical content and only writes the remapped occurrence", async () => {
  const historical = basePackage();
  const incoming = incomingVariant(historical, 3, "changed-answer-three");
  const item = prepared(incoming, [historical]);
  const reviews = buildReadingDuplicateReviewPlans([item], []);
  const [resolved] = resolveReadingDuplicateImports([item], reviews, new Map([[
    reviews[0].pendingId,
    {
      pendingId: reviews[0].pendingId,
      action: "reuse_existing",
      candidateLogicalItemId: historical.item.logicalItemId
    }
  ]]));

  assert.equal(resolved.existingItem.logicalItemId, historical.item.logicalItemId);
  assert.equal(resolved.packageData.item.logicalItemId, historical.item.logicalItemId);
  assert.equal(resolved.packageData.questions[0].questionId, historical.questions[0].questionId);
  assert.equal(resolved.packageData.questions[0].payload.slots[0].answer, historical.questions[0].payload.slots[0].answer);
  assert.equal(resolved.packageData.occurrences.length, 1);
  assert.equal(resolved.packageData.occurrences[0].logicalItemId, historical.item.logicalItemId);

  const calls = [];
  await importReadingPackageAtomic({
    async rpc(name, args) {
      calls.push({ name, args });
      return {
        data: {
          logical_item_action: "reuse_existing",
          inserted_occurrence_count: 1,
          existing_occurrence_count: 0,
          inserted_question_count: 0,
          updated_question_count: 1
        },
        error: null
      };
    }
  }, resolved.packageData);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.p_rows.reading_logical_items[0].logical_item_id, historical.item.logicalItemId);
  assert.equal(calls[0].args.p_rows.reading_source_occurrences[0].logical_item_id, historical.item.logicalItemId);
  assert.equal(calls[0].args.p_rows.reading_question_occurrences[0].question_id, historical.questions[0].questionId);
});

test("manual create keeps and writes a distinct logical item while another pending item can reuse", async () => {
  const historical = basePackage();
  const reusedIncoming = incomingVariant(historical, 4, "reuse-variant");
  const newIncoming = incomingVariant(historical, 5, "new-variant");
  const normalIncoming = incomingVariant(historical, 6, "normal-distinct");
  const reuseItem = prepared(reusedIncoming, [historical]);
  const newItem = prepared(newIncoming, [historical]);
  const normalItem = prepared(normalIncoming);
  const items = [reuseItem, newItem, normalItem];
  const reviews = buildReadingDuplicateReviewPlans(items, []);
  const resolutions = new Map([
    [reviews[0].pendingId, {
      pendingId: reviews[0].pendingId,
      action: "reuse_existing",
      candidateLogicalItemId: historical.item.logicalItemId
    }],
    [reviews[1].pendingId, {
      pendingId: reviews[1].pendingId,
      action: "create_new"
    }]
  ]);
  const resolved = resolveReadingDuplicateImports(items, reviews, resolutions);

  assert.equal(resolved.length, 3);
  assert.ok(resolved.some((item) => item.packageData.item.logicalItemId === historical.item.logicalItemId));
  assert.ok(resolved.some((item) => item.packageData.item.logicalItemId === newIncoming.item.logicalItemId));
  assert.ok(resolved.some((item) => item.packageData.item.logicalItemId === normalIncoming.item.logicalItemId));
  assert.equal(
    resolved.find((item) => item.packageData.item.logicalItemId === newIncoming.item.logicalItemId).existingItem,
    null
  );
  assert.equal(
    resolved.find((item) => item.packageData.item.logicalItemId === normalIncoming.item.logicalItemId).existingItem,
    null
  );
  const newResolved = resolved.find(
    (item) => item.packageData.item.logicalItemId === newIncoming.item.logicalItemId
  );
  const calls = [];
  await importReadingPackageAtomic({
    async rpc(name, args) {
      calls.push({ name, args });
      return {
        data: {
          logical_item_action: "create_new",
          inserted_occurrence_count: 1,
          existing_occurrence_count: 0,
          inserted_question_count: 1,
          updated_question_count: 0
        },
        error: null
      };
    }
  }, newResolved.packageData);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.p_rows.reading_logical_items[0].logical_item_id, newIncoming.item.logicalItemId);
  assert.equal(calls[0].args.p_rows.reading_source_occurrences.length, 1);
});

test("two batch duplicates can resolve independently and circular merge choices are rejected", () => {
  const historical = basePackage();
  const first = prepared(incomingVariant(historical, 7, "batch-one"));
  const second = prepared(incomingVariant(historical, 8, "batch-two"));
  const duplicate = {
    reason: "batch possible duplicate",
    sourceOccurrences: [
      first.packageData.occurrences[0].sourceLabel,
      second.packageData.occurrences[0].sourceLabel
    ]
  };
  const reviews = buildReadingDuplicateReviewPlans([first, second], [duplicate]);
  assert.equal(reviews.length, 2);

  const independent = resolveReadingDuplicateImports([first, second], reviews, new Map([
    [reviews[0].pendingId, { pendingId: reviews[0].pendingId, action: "reuse_existing", candidateLogicalItemId: second.packageData.item.logicalItemId }],
    [reviews[1].pendingId, { pendingId: reviews[1].pendingId, action: "create_new" }]
  ]));
  assert.equal(independent.length, 1);
  assert.equal(independent[0].packageData.occurrences.length, 2);

  assert.throws(() => resolveReadingDuplicateImports([first, second], reviews, new Map([
    [reviews[0].pendingId, { pendingId: reviews[0].pendingId, action: "reuse_existing", candidateLogicalItemId: second.packageData.item.logicalItemId }],
    [reviews[1].pendingId, { pendingId: reviews[1].pendingId, action: "reuse_existing", candidateLogicalItemId: first.packageData.item.logicalItemId }]
  ])), /循环归组/);
});
