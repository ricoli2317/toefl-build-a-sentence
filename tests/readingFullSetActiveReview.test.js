const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildReadingFullSetActiveReviewItems,
  readingFullSetActiveReviewIndex,
  readingFullSetActiveReviewTarget,
  readingFullSetCompletedQuestionNumbersFromRows
} = require("../lib/reading/fullSetActiveReview.ts");

const projectRoot = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(projectRoot, file), "utf8");

const occurrences = [
  { occurrenceId: "m1-ctw", logicalItemId: "ctw", taskType: "ctw", sourceQuestionStart: 1, sourceQuestionEnd: 3 },
  { occurrenceId: "m1-rdl", logicalItemId: "rdl", taskType: "rdl", sourceQuestionStart: 4, sourceQuestionEnd: 5 },
  { occurrenceId: "m1-rap", logicalItemId: "rap", taskType: "rap", sourceQuestionStart: 6, sourceQuestionEnd: 8 }
];

const ctwPractice = {
  item: { module: "ctw" },
  questions: [{
    questionId: "ctw-question",
    questionType: "ctw",
    slots: [
      { slotId: "slot-1", slotOrder: 1, missingLength: 2 },
      { slotId: "slot-2", slotOrder: 2, missingLength: 2 },
      { slotId: "slot-3", slotOrder: 3, missingLength: 1 }
    ]
  }]
};

const rdlPractice = {
  item: { module: "rdl" },
  questions: [
    { questionId: "rdl-1", questionType: "rdl" },
    { questionId: "rdl-2", questionType: "rdl" }
  ]
};

const rapPractice = {
  item: { module: "rap" },
  questions: [
    { questionId: "rap-1", questionType: "rap_multiple_choice" },
    { questionId: "rap-2", questionType: "rap_sentence_insertion" },
    { questionId: "rap-3", questionType: "rap_sentence_selection" }
  ]
};

function payloads() {
  return {
    "m1-ctw": { practice: ctwPractice },
    "m1-rdl": { practice: rdlPractice },
    "m1-rap": { practice: rapPractice }
  };
}

function answers() {
  return {
    "m1-ctw": {
      "ctw-question": { kind: "ctw", slots: { "slot-1": ["a", "b"], "slot-2": ["c", ""] } }
    },
    "m1-rdl": {
      "rdl-1": { kind: "choice", optionId: "option-2" },
      "rdl-2": { kind: "choice", optionId: null }
    },
    "m1-rap": {
      "rap-1": { kind: "choice", optionId: "option-1" },
      "rap-2": { kind: "insertion", anchorId: "anchor-3" },
      "rap-3": { kind: "sentence_selection", sentenceId: null }
    }
  };
}

test("active Full Set Review expands CTW scoring slots and uses live CTW, RDL, and RAP answers", () => {
  const items = buildReadingFullSetActiveReviewItems({
    answersByOccurrence: answers(),
    moduleAttemptId: "module-1",
    occurrencePayloads: payloads(),
    occurrences
  });
  assert.deepEqual(items.map((item) => item.questionNumber), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(items.map((item) => item.completed), [true, false, false, true, false, true, true, false]);
  assert.deepEqual(
    items.slice(0, 3).map((item) => [item.occurrenceId, item.questionIndex, item.scoringPointIndex]),
    [["m1-ctw", 0, 0], ["m1-ctw", 0, 1], ["m1-ctw", 0, 2]]
  );

  const editedAnswers = answers();
  editedAnswers["m1-rdl"]["rdl-2"] = { kind: "choice", optionId: "option-3" };
  assert.equal(buildReadingFullSetActiveReviewItems({
    answersByOccurrence: editedAnswers,
    moduleAttemptId: "module-1",
    occurrencePayloads: payloads(),
    occurrences
  })[4].completed, true);
});

test("Review targets CTW slots and RDL or RAP workspace questions through the official occurrence mapping", () => {
  const items = buildReadingFullSetActiveReviewItems({
    answersByOccurrence: answers(),
    moduleAttemptId: "module-1",
    occurrencePayloads: payloads(),
    occurrences
  });
  assert.deepEqual(readingFullSetActiveReviewTarget(items[1], "module-1", occurrences), {
    occurrenceIndex: 0,
    questionIndex: 0
  });
  assert.deepEqual(readingFullSetActiveReviewTarget(items[4], "module-1", occurrences), {
    occurrenceIndex: 1,
    questionIndex: 1
  });
  assert.deepEqual(readingFullSetActiveReviewTarget(items[7], "module-1", occurrences), {
    occurrenceIndex: 2,
    questionIndex: 2
  });
  assert.equal(readingFullSetActiveReviewIndex(items, { occurrenceIndex: 0, questionIndex: 0 }, 1), 1);
});

test("Module scope is rebuilt from only the active Module and rejects every stale Module target", () => {
  const module1Occurrences = [
    { occurrenceId: "m1-all", logicalItemId: "m1", taskType: "rap", sourceQuestionStart: 1, sourceQuestionEnd: 35 }
  ];
  const module2Occurrences = [
    { occurrenceId: "m2-ctw", logicalItemId: "m2-ctw", taskType: "ctw", sourceQuestionStart: 1, sourceQuestionEnd: 10 },
    { occurrenceId: "m2-rap", logicalItemId: "m2-rap", taskType: "rap", sourceQuestionStart: 11, sourceQuestionEnd: 15 }
  ];
  const m1 = buildReadingFullSetActiveReviewItems({
    answersByOccurrence: {}, moduleAttemptId: "module-1", occurrencePayloads: {}, occurrences: module1Occurrences
  });
  const m2 = buildReadingFullSetActiveReviewItems({
    answersByOccurrence: {}, moduleAttemptId: "module-2", occurrencePayloads: {}, occurrences: module2Occurrences
  });
  assert.equal(m1.length, 35);
  assert.deepEqual([m1[0].label, m1[34].label], ["1", "35"]);
  assert.equal(m2.length, 15);
  assert.deepEqual([m2[0].label, m2[14].label], ["1", "15"]);
  assert.equal(m2.some((item) => item.occurrenceId.startsWith("m1-")), false);
  assert.equal(readingFullSetActiveReviewTarget(m1[0], "module-2", module2Occurrences), null);
  assert.equal(readingFullSetActiveReviewTarget({ ...m2[0], occurrenceIndex: 99 }, "module-2", module2Occurrences), null);
});

test("resumed Module completion snapshot maps persisted CTW slots and RDL or RAP questions without loading materials", () => {
  const completed = readingFullSetCompletedQuestionNumbersFromRows({
    answers: [
      { occurrenceId: "m1-ctw", questionId: "ctw-question", slotId: "slot-2", studentAnswer: "word" },
      { occurrenceId: "m1-ctw", questionId: "ctw-question", slotId: "slot-3", studentAnswer: "" },
      { occurrenceId: "m1-rdl", questionId: "rdl-2", slotId: null, studentAnswer: "option-3" },
      { occurrenceId: "m1-rap", questionId: "rap-3", slotId: null, studentAnswer: null }
    ],
    occurrences,
    questionOccurrences: [
      { occurrenceId: "m1-ctw", questionId: "ctw-question", sourceQuestionStart: 1 },
      { occurrenceId: "m1-rdl", questionId: "rdl-1", sourceQuestionStart: 4 },
      { occurrenceId: "m1-rdl", questionId: "rdl-2", sourceQuestionStart: 5 },
      { occurrenceId: "m1-rap", questionId: "rap-3", sourceQuestionStart: 8 }
    ],
    slots: [
      { questionId: "ctw-question", slotId: "slot-1", slotOrder: 1 },
      { questionId: "ctw-question", slotId: "slot-2", slotOrder: 2 },
      { questionId: "ctw-question", slotId: "slot-3", slotOrder: 3 }
    ]
  });
  assert.deepEqual(completed, [2, 5]);

  const resumedItems = buildReadingFullSetActiveReviewItems({
    answersByOccurrence: {},
    completedQuestionNumbers: new Set(completed),
    moduleAttemptId: "module-1",
    occurrencePayloads: {},
    occurrences
  });
  assert.equal(resumedItems[1].completed, true);
  assert.equal(resumedItems[4].completed, true);
});

test("BAS and active Reading Full Set share one Review UI while Full Set open stays client-only", () => {
  const bas = read("components/PracticeSession.tsx");
  const runner = read("components/reading/ReadingFullSetRunner.tsx");
  const shared = read("components/shared/PracticeReview.tsx");
  const server = read("lib/reading/fullSetAttemptServer.ts");
  const resumeRoute = read("app/api/reading/full-set-attempts/[attemptId]/route.ts");
  const m1Route = read("app/api/reading/full-set-attempts/route.ts");
  const m2Route = read("app/api/reading/full-set-attempts/[attemptId]/modules/2/start/route.ts");
  assert.match(bas, /import \{ PracticeReview \}/);
  assert.match(bas, /<PracticeReview/);
  assert.doesNotMatch(bas, /function ReviewPanel/);
  assert.match(runner, /<PracticeReview/);
  assert.match(runner, /layout="compact"/);
  assert.match(runner, /max-w-\[1600px\]/);
  assert.match(runner, /onReview=\{\(\) => setShowReview\(true\)\}/);
  assert.match(runner, /setShowReview\(false\)[\s\S]*setCtwReviewScoringPointIndex\(0\)/);
  assert.match(shared, /Completed[\s\S]*Incomplete/);
  assert.match(shared, /min-\[1100px\]:grid-cols-5/);
  assert.match(shared, /compact \? null : <h2[^>]*>Question status<\/h2>/);
  assert.match(shared, /compact && item\.questionNumber !== undefined \? item\.questionNumber : item\.label/);
  const basReview = bas.slice(bas.indexOf("<PracticeReview"), bas.indexOf("/>", bas.indexOf("<PracticeReview")) + 2);
  assert.doesNotMatch(basReview, /layout=/);
  const headerOpen = runner.slice(runner.indexOf("<ReadingPracticeHeader"), runner.indexOf("<main"));
  assert.doesNotMatch(headerOpen, /fetch\(|loadRunner|acquireOccurrence/);
  assert.match(server, /answerRevision === 0[\s\S]*return \[\]/);
  for (const route of [resumeRoute, m1Route, m2Route]) {
    assert.match(route, /loadReadingFullSetReviewCompletedQuestionNumbers/);
    assert.match(route, /reviewCompletedQuestionNumbers/);
  }
});
