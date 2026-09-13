const assert = require("node:assert/strict");
const test = require("node:test");

const { compareCtwPackageLogicalIdentity } = require("../lib/reading/ctwLogicalIdentity.ts");
const { buildReadingDuplicateReviewPlans } = require("../lib/reading/duplicateResolution.ts");
const { buildReadingDuplicateResolutionItem } = require("../lib/reading/duplicateResolutionView.ts");

const INCOMING_COMPLETED = "Deserts, often characterized by aridity and extreme temperatures, have long been dismissed as barren wastelands. However, this perception overlooks the critical ecological significance and the remarkable adaptations of the organisms they host. These severe environments require resilience and innovation, with plants and animals developing unique survival strategies. Moreover, deserts play a vital role in global carbon cycles, and their vast landscapes offer unparalleled opportunities for research into climate change impacts. Thus, recognizing the intrinsic value of deserts is essential for fostering a deeper appreciation and commitment to desert conservation.";
const CANDIDATE_COMPLETED = INCOMING_COMPLETED.replace("overlooks the critical", "overlooks their critical");
const ANSWERS = ["perception", "the", "ecological", "and", "remarkable", "of", "organisms", "host", "severe", "require"];
const PREFIXES = ["perce", "th", "ecol", "a", "rem", "o", "org", "ho", "sev", "req"];

function ctwPackage({ logicalItemId, sourceLabel, date, completed, answers, spacedDisplay }) {
  const paragraphId = `${logicalItemId}-p1`;
  const slots = answers.map((answer, index) => {
    const prefix = PREFIXES[index];
    const missingText = answer.slice(prefix.length);
    return {
      slotId: `${logicalItemId}-slot-${index + 1}`,
      slotOrder: index + 1,
      paragraphId,
      answer,
      prefix,
      displayText: spacedDisplay && missingText.length > 0
        ? `${prefix}_${" _".repeat(missingText.length - 1)}`
        : `${prefix}${"_".repeat(missingText.length)}`,
      missingText,
      missingLength: missingText.length
    };
  });
  const segments = [];
  let cursor = 0;
  for (const slot of slots) {
    const index = completed.indexOf(slot.answer, cursor);
    assert.notEqual(index, -1, `answer ${slot.answer} must occur after offset ${cursor}`);
    segments.push({ kind: "text", text: completed.slice(cursor, index) });
    segments.push({ kind: "blank", slotId: slot.slotId });
    cursor = index + slot.answer.length;
  }
  segments.push({ kind: "text", text: completed.slice(cursor) });
  const question = {
    questionId: `${logicalItemId}-q1`,
    logicalItemId,
    questionOrder: 1,
    questionType: "ctw",
    stem: "Complete the words.",
    rawDisplayText: null,
    payload: {
      paragraphs: [{
        paragraphId,
        paragraphOrder: 1,
        rawText: segments.map((segment) => segment.kind === "text"
          ? segment.text
          : slots.find((slot) => slot.slotId === segment.slotId).displayText).join(""),
        segments
      }],
      slots
    }
  };
  return {
    schemaVersion: 2,
    item: {
      logicalItemId,
      module: "ctw",
      title: null,
      firstSeenDate: date,
      firstSeenSourceLabel: sourceLabel,
      firstSeenSourceOrder: sourceLabel === "7.6A" ? 1 : 2,
      dedupFingerprint: logicalItemId,
      questionCount: 1,
      scoredItemCount: 10,
      isActive: true
    },
    occurrences: [{
      occurrenceId: `${logicalItemId}-occurrence`,
      logicalItemId,
      sourceKind: "real_exam",
      sourceLabel,
      occurrenceDate: date,
      yearMonth: date.slice(0, 7),
      sourceQuestionFile: "",
      sourceAnswerFile: "",
      sourceModule: "m1",
      sourceOrder: sourceLabel === "7.6A" ? 1 : 2,
      sourceQuestionStart: 1,
      sourceQuestionEnd: 10,
      questionSources: [{ questionId: question.questionId, sourceQuestionStart: 1, sourceQuestionEnd: 10 }]
    }],
    materials: [],
    passages: [],
    questions: [question]
  };
}

function prepared(packageData, candidate) {
  return {
    packageData,
    existingItem: null,
    reuseKind: "new",
    batchSemanticReuseCount: 0,
    possibleDuplicateLogicalItemIds: [candidate.item.logicalItemId],
    possibleDuplicateCandidates: [candidate],
    contentReconciliations: [],
    historicalDuplicateLogicalItemIds: [],
    materialMatchKind: "not_applicable",
    addedOccurrenceCount: 1,
    occurrenceConflict: null
  };
}

test("7.6A the/their boundary remains pending and exposes only its exact content differences", () => {
  const incoming = ctwPackage({
    logicalItemId: "reading-ctw-b5ff85d5562f2bae74332728",
    sourceLabel: "7.6A",
    date: "2026-07-06",
    completed: INCOMING_COMPLETED,
    answers: ANSWERS,
    spacedDisplay: true
  });
  const candidate = ctwPackage({
    logicalItemId: "reading-ctw-4071b4f1e12aa0cf95219e97",
    sourceLabel: "260426HE-M1",
    date: "2026-04-26",
    completed: CANDIDATE_COMPLETED,
    answers: ANSWERS.map((answer, index) => index === 1 ? "their" : answer),
    spacedDisplay: false
  });

  const comparison = compareCtwPackageLogicalIdentity(incoming, candidate);
  assert.equal(comparison.sameLogicalItem, false);
  assert.equal(comparison.leftIdentity.key, "b5ff85d5562f2bae74332728fd92a35ae935e6ae3a683681c0e8c178ef63708e");
  assert.equal(comparison.rightIdentity.key, "8fada11aa112e9fe1147f0344c7e88ca4c643bb81a3d36d17dc997a40ecb6c93");

  const reviews = buildReadingDuplicateReviewPlans([prepared(incoming, candidate)]);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].resolutionId, "reading-duplicate:ctw:reading-ctw-b5ff85d5562f2bae74332728");
  const item = buildReadingDuplicateResolutionItem(reviews[0], new Map());
  assert.equal(item.resolution, null);
  const differences = item.candidates[0].detectedDifferences;
  assert.deepEqual(
    differences.filter((difference) => difference.kind === "passage_lexical")
      .map(({ incoming: left, candidate: right }) => [left, right]),
    [["the", "their"]]
  );
  assert.deepEqual(
    differences.filter((difference) => difference.kind === "answer")
      .map(({ location, incoming: left, candidate: right }) => [location, left, right]),
    [["第 2 空答案", "the", "their"]]
  );
  assert.equal(differences.some((difference) => difference.kind === "answer_order"), false);
  assert.equal(differences.some((difference) => difference.kind === "prefix"), false);
  assert.equal(differences.some((difference) => difference.kind === "punctuation"), false);
  assert.equal(differences.some((difference) => difference.kind === "whitespace"), false);
  assert.equal(differences.some((difference) => difference.kind === "display"), true);
});
