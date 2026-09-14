const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { parseCsvDocument } = require("../lib/csv.ts");
const { adaptReadingCsv } = require("../lib/reading/csvAdapter.ts");
const {
  buildReadingDuplicateReviewPlans,
  coalesceResolvedReadingImportsByFingerprint,
  indexReadingDuplicateResolutions,
  resolveReadingDuplicateImports
} = require("../lib/reading/duplicateResolution.ts");
const { assertReadingPendingResolutionInvariant } = require("../lib/reading/duplicateResolutionModel.ts");
const { buildReadingDuplicateResolutionItem } = require("../lib/reading/duplicateResolutionView.ts");
const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const { importReadingPackageAtomic } = require("../lib/reading/importer.ts");
const { arePossibleReadingDuplicates } = require("../lib/reading/semantic.ts");

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

function modulePackage(module) {
  if (module === "ctw") return basePackage();
  const file = module === "rdl"
    ? "../data/reading/import-packages/rdl/reading-rdl-590c3732c15f9453625de6d7.json"
    : "../data/reading/import-packages/rap/reading-rap-199501db577904fb79815267.json";
  return JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8"));
}

function relabeledIncoming(historical, suffix) {
  const incoming = structuredClone(historical);
  const logicalItemId = `${historical.item.logicalItemId}-incoming-${suffix}`;
  incoming.item.logicalItemId = logicalItemId;
  incoming.item.firstSeenDate = `2026-09-${String(suffix).padStart(2, "0")}`;
  incoming.item.firstSeenSourceLabel = `9.${suffix}A`;
  incoming.item.firstSeenSourceOrder = suffix;
  for (const occurrence of incoming.occurrences) {
    occurrence.occurrenceId = `${occurrence.occurrenceId}-incoming-${suffix}`;
    occurrence.logicalItemId = logicalItemId;
    occurrence.sourceLabel = `9.${suffix}A`;
    occurrence.occurrenceDate = incoming.item.firstSeenDate;
    occurrence.yearMonth = "2026-09";
    occurrence.sourceOrder = suffix;
  }
  for (const passage of incoming.passages) passage.logicalItemId = logicalItemId;
  for (const question of incoming.questions) question.logicalItemId = logicalItemId;
  return incoming;
}

function incomingVariant(historical, suffix, answer) {
  const occurrence = historical.occurrences[0];
  const question = structuredClone(historical.questions[0]);
  question.logicalItemId = "temporary";
  question.questionId = `temporary-${suffix}`;
  question.stem = `${question.stem} (${suffix})`;
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
  const packageData = groupReadingSourceOccurrences([candidate]).packages[0];
  const firstText = packageData.questions[0].payload.paragraphs[0].segments.find((segment) => segment.kind === "text");
  firstText.text = `Variant ${suffix}. ${firstText.text}`;
  packageData.questions[0].payload.paragraphs[0].rawText = `Variant ${suffix}. ${packageData.questions[0].payload.paragraphs[0].rawText}`;
  packageData.item.logicalItemId = `${packageData.item.logicalItemId}-variant-${suffix}`;
  packageData.questions[0].logicalItemId = packageData.item.logicalItemId;
  packageData.occurrences[0].logicalItemId = packageData.item.logicalItemId;
  return packageData;
}

function prepared(packageData, candidates = []) {
  return {
    packageData,
    existingItem: null,
    reuseKind: "new",
    batchSemanticReuseCount: 0,
    possibleDuplicateLogicalItemIds: candidates.map((candidate) => candidate.item.logicalItemId),
    possibleDuplicateCandidates: candidates,
    contentReconciliations: [],
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
  const reviews = buildReadingDuplicateReviewPlans([item]);

  assert.equal(reviews.length, 1);
  assert.equal(
    reviews[0].resolutionId,
    `reading-duplicate:ctw:${[incoming.item.logicalItemId, historical.item.logicalItemId].sort().join(":")}`
  );
  assert.equal(reviews[0].questionType, "ctw");
  assert.equal(reviews[0].identityScope, "logical_item");
  assert.equal(reviews[0].incoming, item);
  assert.deepEqual(reviews[0].candidates.map((candidate) => candidate.item.logicalItemId), [
    historical.item.logicalItemId
  ]);
});

test("Reading final resolution refuses unresolved and forged candidate choices", () => {
  const historical = basePackage();
  const incoming = incomingVariant(historical, 2, "changed-answer-two");
  const item = prepared(incoming, [historical]);
  const reviews = buildReadingDuplicateReviewPlans([item]);

  assert.throws(
    () => resolveReadingDuplicateImports([item], reviews, new Map()),
    /尚未处理/
  );
  assert.throws(
    () => resolveReadingDuplicateImports([item], reviews, new Map([[
      reviews[0].resolutionId,
      { resolutionId: reviews[0].resolutionId, questionType: "ctw", action: "reuse_existing", logicalItemId: "forged" }
    ]])),
    /无效的候选题/
  );
});

test("manual reuse keeps the historical logical content and only writes the remapped occurrence", async () => {
  const historical = basePackage();
  const incoming = incomingVariant(historical, 3, "changed-answer-three");
  const item = prepared(incoming, [historical]);
  const reviews = buildReadingDuplicateReviewPlans([item]);
  const [resolved] = resolveReadingDuplicateImports([item], reviews, new Map([[
    reviews[0].resolutionId,
    {
      resolutionId: reviews[0].resolutionId,
      questionType: "ctw",
      action: "reuse_existing",
      logicalItemId: historical.item.logicalItemId
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
  const reviews = buildReadingDuplicateReviewPlans(items);
  const reviewByIncomingId = new Map(reviews.map((review) => [
    review.incoming.packageData.item.logicalItemId,
    review
  ]));
  const reuseReview = reviewByIncomingId.get(reusedIncoming.item.logicalItemId);
  const newReview = reviewByIncomingId.get(newIncoming.item.logicalItemId);
  const resolutions = new Map([
    [reuseReview.resolutionId, {
      resolutionId: reuseReview.resolutionId,
      questionType: "ctw",
      action: "reuse_existing",
      logicalItemId: historical.item.logicalItemId
    }],
    [newReview.resolutionId, {
      resolutionId: newReview.resolutionId,
      questionType: "ctw",
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

test("one unordered batch pair produces exactly one review", () => {
  const historical = modulePackage("rdl");
  const firstPackage = relabeledIncoming(historical, 7);
  const secondPackage = relabeledIncoming(historical, 8);
  firstPackage.materials[0].materialId = "RDL-095";
  firstPackage.materials[0].imageAssetPath = "reading/rdl/RDL-095/material_final.png";
  secondPackage.materials[0].materialId = "RDL-127";
  secondPackage.materials[0].imageAssetPath = "reading/rdl/RDL-127/material_final.png";
  const first = prepared(firstPackage);
  const second = prepared(secondPackage);
  const reviews = buildReadingDuplicateReviewPlans([first, second]);
  assert.equal(reviews.length, 1);
  const reverseReviews = buildReadingDuplicateReviewPlans([second, first]);
  assert.equal(reverseReviews.length, 1);
  assert.equal(reverseReviews[0].resolutionId, reviews[0].resolutionId);

  const merged = resolveReadingDuplicateImports([first, second], reviews, new Map([
    [reviews[0].resolutionId, { resolutionId: reviews[0].resolutionId, questionType: "rdl", action: "reuse_existing", logicalItemId: second.packageData.item.logicalItemId }],
  ]));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].packageData.occurrences.length, 2);
});

test("CTW, RDL, and RAP all adapt duplicate candidates to one resolution plan shape", () => {
  const expectedScopes = { ctw: "logical_item", rdl: "material", rap: "passage" };
  for (const module of ["ctw", "rdl", "rap"]) {
    const historical = modulePackage(module);
    const incoming = module === "ctw"
      ? incomingVariant(historical, 9, "different-answer")
      : relabeledIncoming(historical, module === "rdl" ? 10 : 11);
    const item = prepared(incoming, [historical]);
    if (module === "rdl") item.materialMatchKind = "possible_material_duplicate";
    const [review] = buildReadingDuplicateReviewPlans([item]);
    assert.ok(review);
    assert.equal(review.questionType, module);
    assert.equal(review.identityScope, expectedScopes[module]);
    assert.equal(
      review.resolutionId,
      `reading-duplicate:${module}:${[incoming.item.logicalItemId, historical.item.logicalItemId].sort().join(":")}`
    );
    assert.equal(review.candidates[0].item.logicalItemId, historical.item.logicalItemId);
    const resolutionItem = buildReadingDuplicateResolutionItem(review, new Map());
    assert.equal(resolutionItem.questionType, module);
    assert.equal(resolutionItem.incoming.questionType, module);
    assert.equal(resolutionItem.candidates[0].questionType, module);
    assert.equal(resolutionItem.candidates[0].logicalItemId, historical.item.logicalItemId);
    if (module === "ctw") {
      assert.ok(resolutionItem.incoming.detail.passage);
      assert.ok(resolutionItem.incoming.detail.orderedBlanks.length > 0);
      assert.ok(resolutionItem.incoming.detail.correctAnswers.length > 0);
    } else if (module === "rdl") {
      assert.ok(resolutionItem.incoming.detail.materialId);
      assert.equal("questions" in resolutionItem.incoming.detail, false);
    } else {
      assert.ok(resolutionItem.incoming.detail.passageTitle);
      assert.equal("passage" in resolutionItem.incoming.detail, false);
      assert.equal("questions" in resolutionItem.incoming.detail, false);
    }
  }
});

test("RDL material pending cannot exist without an actionable logical candidate", () => {
  const incoming = relabeledIncoming(modulePackage("rdl"), 12);
  const item = prepared(incoming);
  item.materialMatchKind = "possible_material_duplicate";
  assert.throws(
    () => buildReadingDuplicateReviewPlans([item]),
    /没有生成可操作候选/
  );
});

test("all three Reading modules support reuse, create-new, unresolved rejection, and atomic DB payloads", async () => {
  for (const [module, suffix] of [["ctw", 13], ["rdl", 14], ["rap", 15]]) {
    const historical = modulePackage(module);
    const incoming = module === "ctw"
      ? incomingVariant(historical, suffix, `${module}-changed`)
      : relabeledIncoming(historical, suffix);
    const item = prepared(incoming, [historical]);
    if (module === "rdl") item.materialMatchKind = "possible_material_duplicate";
    const reviews = buildReadingDuplicateReviewPlans([item]);
    const review = reviews[0];

    assert.throws(() => resolveReadingDuplicateImports([item], reviews, new Map()), /尚未处理/);

    const reuse = indexReadingDuplicateResolutions(reviews, [{
      resolutionId: review.resolutionId,
      questionType: module,
      action: "reuse_existing",
      logicalItemId: historical.item.logicalItemId
    }]);
    const [reused] = resolveReadingDuplicateImports([item], reviews, reuse);
    assert.equal(reused.packageData.item.logicalItemId, historical.item.logicalItemId);
    assert.equal(reused.existingItem.logicalItemId, historical.item.logicalItemId);
    const reuseCalls = [];
    await importReadingPackageAtomic({
      async rpc(name, args) {
        reuseCalls.push({ name, args });
        return {
          data: {
            logical_item_action: "reuse_existing",
            inserted_occurrence_count: 1,
            existing_occurrence_count: 0,
            inserted_question_count: 0,
            updated_question_count: historical.questions.length
          },
          error: null
        };
      }
    }, reused.packageData);
    assert.equal(reuseCalls[0].args.p_rows.reading_logical_items[0].logical_item_id, historical.item.logicalItemId);
    assert.ok(reuseCalls[0].args.p_rows.reading_source_occurrences.every(
      (occurrence) => occurrence.logical_item_id === historical.item.logicalItemId
    ));

    const create = indexReadingDuplicateResolutions(reviews, [{
      resolutionId: review.resolutionId,
      questionType: module,
      action: "create_new"
    }]);
    const [created] = resolveReadingDuplicateImports([item], reviews, create);
    assert.equal(created.packageData.item.logicalItemId, incoming.item.logicalItemId);
    assert.equal(created.existingItem, null);
    const createCalls = [];
    await importReadingPackageAtomic({
      async rpc(name, args) {
        createCalls.push({ name, args });
        return {
          data: {
            logical_item_action: "create_new",
            inserted_occurrence_count: 1,
            existing_occurrence_count: 0,
            inserted_question_count: incoming.questions.length,
            updated_question_count: 0
          },
          error: null
        };
      }
    }, created.packageData);
    assert.equal(createCalls[0].args.p_rows.reading_logical_items[0].logical_item_id, incoming.item.logicalItemId);
  }
});

test("cross-type pending decisions stay independent and require complete valid payloads", () => {
  const preparedItems = ["ctw", "rdl", "rap"].map((module, index) => {
    const historical = modulePackage(module);
    const incoming = module === "ctw"
      ? incomingVariant(historical, 16, "cross-type")
      : relabeledIncoming(historical, 17 + index);
    const item = prepared(incoming, [historical]);
    if (module === "rdl") item.materialMatchKind = "possible_material_duplicate";
    return item;
  });
  const reviews = buildReadingDuplicateReviewPlans(preparedItems);
  assert.deepEqual(reviews.map((review) => review.questionType).sort(), ["ctw", "rap", "rdl"]);
  assert.throws(() => indexReadingDuplicateResolutions(reviews, [{
    resolutionId: reviews[0].resolutionId,
    questionType: reviews[1].questionType,
    action: "create_new"
  }]), /题型无效/);

  const partial = indexReadingDuplicateResolutions(reviews, reviews.slice(0, 2).map((review) => ({
    resolutionId: review.resolutionId,
    questionType: review.questionType,
    action: "create_new"
  })));
  assert.throws(() => resolveReadingDuplicateImports(preparedItems, reviews, partial), /尚未处理/);

  const complete = indexReadingDuplicateResolutions(reviews, reviews.map((review, index) => index === 0
    ? {
        resolutionId: review.resolutionId,
        questionType: review.questionType,
        action: "reuse_existing",
        logicalItemId: review.candidates[0].item.logicalItemId
      }
    : {
        resolutionId: review.resolutionId,
        questionType: review.questionType,
        action: "create_new"
      }));
  assert.equal(resolveReadingDuplicateImports(preparedItems, reviews, complete).length, 3);
});

test("final plan executes one create for same-batch fingerprint equivalents", () => {
  const base = basePackage();
  const first = relabeledIncoming(base, 27);
  const second = relabeledIncoming(base, 28);
  const plans = [first, second].map((packageData) => ({
    packageData,
    existingItem: null,
    members: [prepared(packageData)],
    manuallyResolved: false
  }));

  const finalized = coalesceResolvedReadingImportsByFingerprint(plans);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].existingItem, null);
  assert.equal(finalized[0].members.length, 2);
  assert.deepEqual(
    finalized[0].packageData.occurrences.map((occurrence) => occurrence.sourceLabel),
    ["9.27A", "9.28A"]
  );
  assert.ok(finalized[0].packageData.occurrences.every((occurrence) =>
    occurrence.logicalItemId === finalized[0].packageData.item.logicalItemId
  ));
});

test("final plan exposes a same-fingerprint identity inconsistency before execution", () => {
  const base = basePackage();
  const first = relabeledIncoming(base, 29);
  const inconsistent = relabeledIncoming(base, 30);
  const question = inconsistent.questions[0];
  const text = question.payload.paragraphs[0].segments.find((segment) => segment.kind === "text");
  text.text = `Identity-changing text. ${text.text}`;
  question.payload.paragraphs[0].rawText = `Identity-changing text. ${question.payload.paragraphs[0].rawText}`;
  const plans = [first, inconsistent].map((packageData) => ({
    packageData,
    existingItem: null,
    members: [prepared(packageData)],
    manuallyResolved: false
  }));

  assert.throws(
    () => coalesceResolvedReadingImportsByFingerprint(plans),
    (error) => error.code === "READING_DEDUP_FINGERPRINT_IDENTITY_INCONSISTENCY"
  );
});

test("pending flag and actionable list invariant is enforced for every Reading type", () => {
  const actionableItems = ["ctw", "rdl", "rap"].map((module, index) => {
    const historical = modulePackage(module);
    const incoming = module === "ctw"
      ? incomingVariant(historical, 20, "invariant")
      : relabeledIncoming(historical, 21 + index);
    const item = prepared(incoming, [historical]);
    if (module === "rdl") item.materialMatchKind = "possible_material_duplicate";
    return buildReadingDuplicateResolutionItem(buildReadingDuplicateReviewPlans([item])[0], new Map());
  });
  assert.doesNotThrow(() => assertReadingPendingResolutionInvariant({
    hasPendingDuplicates: true,
    pendingResolutionItems: actionableItems
  }));
  assert.throws(() => assertReadingPendingResolutionInvariant({
    hasPendingDuplicates: true,
    pendingResolutionItems: []
  }), (error) => error.code === "READING_PENDING_RESOLUTION_INVARIANT");
  assert.throws(() => assertReadingPendingResolutionInvariant({
    hasPendingDuplicates: false,
    pendingResolutionItems: [{
      resolutionId: "orphan",
      questionType: "rap",
      identityScope: "passage",
      reasonCode: "possible_rap_passage",
      reason: "test",
      addedOccurrenceCount: 1,
      existingOccurrenceCount: 0,
      incoming: {},
      candidates: [{}],
      resolution: null
    }]
  }), (error) => error.code === "READING_PENDING_RESOLUTION_INVARIANT");
});

test("RDL-095 and RDL-127 style template-title match lacks structural duplicate evidence", () => {
  const left = relabeledIncoming(modulePackage("rdl"), 31);
  const right = relabeledIncoming(modulePackage("rdl"), 32);
  left.materials[0].materialId = "RDL-095";
  left.materials[0].imageAssetPath = "reading/rdl/RDL-095/material_final.png";
  right.materials[0].materialId = "RDL-127";
  right.materials[0].imageAssetPath = "reading/rdl/RDL-127/material_final.png";
  for (const [index, question] of right.questions.entries()) {
    question.stem = `Different PHYS entity question ${index + 1}`;
  }
  assert.equal(arePossibleReadingDuplicates(left, right), false);
  assert.equal(buildReadingDuplicateReviewPlans([prepared(left), prepared(right)]).length, 0);
});

test("RDL possible-material review carries resolved images for both sides", () => {
  const previousBaseUrl = process.env.READING_ASSET_BASE_URL;
  process.env.READING_ASSET_BASE_URL = "https://assets.example.test";
  try {
    const historical = modulePackage("rdl");
    const incoming = relabeledIncoming(historical, 33);
    incoming.materials[0].materialId = "RDL-127";
    incoming.materials[0].imageAssetPath = "reading/rdl/RDL-127/material_final.png";
    const item = prepared(incoming, [historical]);
    item.materialMatchKind = "possible_material_duplicate";
    const view = buildReadingDuplicateResolutionItem(buildReadingDuplicateReviewPlans([item])[0], new Map());
    assert.equal(view.incoming.detail.imageUrl, "https://assets.example.test/reading/rdl/RDL-127/material_final.png");
    assert.equal(view.candidates[0].detail.imageUrl, `https://assets.example.test/${historical.materials[0].imageAssetPath.replace(/^\/+/, "")}`);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.READING_ASSET_BASE_URL;
    else process.env.READING_ASSET_BASE_URL = previousBaseUrl;
  }
});
