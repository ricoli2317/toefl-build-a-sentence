const assert = require("node:assert/strict");
const test = require("node:test");

const { compareCtwPackageLogicalIdentity } = require("../lib/reading/ctwLogicalIdentity.ts");
const { buildReadingDuplicateReviewPlans } = require("../lib/reading/duplicateResolution.ts");
const { buildReadingContentConflict } = require("../lib/reading/contentReconciliation.ts");

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

function prepared(packageData, candidate, conflict) {
  return {
    packageData,
    existingItem: candidate.item,
    reuseKind: "semantic",
    batchSemanticReuseCount: 0,
    possibleDuplicateLogicalItemIds: [],
    possibleDuplicateCandidates: [],
    contentReconciliations: [{ item: conflict, existingPackage: candidate, incomingPackage: packageData }],
    historicalDuplicateLogicalItemIds: [],
    materialMatchKind: "not_applicable",
    addedOccurrenceCount: 1,
    occurrenceConflict: null
  };
}

test("7.6A the/their boundary reuses one identity and becomes one answer conflict", () => {
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
  assert.equal(comparison.sameLogicalItem, true);
  assert.equal(comparison.leftIdentity.key, comparison.rightIdentity.key);
  assert.equal(comparison.nonIdentityConflicts.length, 1);
  assert.equal(comparison.nonIdentityConflicts[0].kind, "answer_conflict");

  const conflict = buildReadingContentConflict(candidate, incoming);
  assert.ok(conflict);
  assert.deepEqual(conflict.questionConflicts[0].differences.map((item) => item.kind), ["ctw_slot_content"]);
  assert.deepEqual(conflict.questionConflicts[0].ctwSlotConflicts, [{
    slotOrder: 2,
    differenceKinds: ["answer"],
    existing: "th___ → their",
    incoming: "th_ → the",
    existingAnswer: "their",
    incomingAnswer: "the"
  }]);
  assert.equal(buildReadingDuplicateReviewPlans([prepared(incoming, candidate, conflict)]).length, 0);
});
