const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { buildBasReviewQuestionState } = require("../lib/basReviewState.ts");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function chunks(...texts) {
  return JSON.stringify(texts);
}

test("readonly state keeps submitted chunks in submission order and leaves the rest in the tray", () => {
  const state = buildBasReviewQuestionState({
    optionsText: chunks("we", "went", "to", "the", "park", "yesterday"),
    questionId: "bas-q1",
    submittedOrderText: chunks("we", "to", "the", "park")
  });
  assert.deepEqual(state.placedChunks.map((chunk) => chunk.text), ["we", "to", "the", "park"]);
  assert.deepEqual(state.placedChunks.map((chunk) => chunk.id), [
    "bas-q1-0",
    "bas-q1-2",
    "bas-q1-3",
    "bas-q1-4"
  ]);
  assert.deepEqual(state.unusedChunks.map((chunk) => chunk.text), ["went", "yesterday"]);
  assert.deepEqual(state.unusedChunks.map((chunk) => chunk.id), ["bas-q1-1", "bas-q1-5"]);
});

test("a fully used but wrong order keeps the submitted order instead of the option order", () => {
  const state = buildBasReviewQuestionState({
    optionsText: chunks("the", "cat", "sat", "on", "the", "mat"),
    questionId: "bas-q2",
    submittedOrderText: chunks("the", "mat", "sat", "on", "the", "cat")
  });
  assert.deepEqual(state.placedChunks.map((chunk) => chunk.id), [
    "bas-q2-0",
    "bas-q2-5",
    "bas-q2-2",
    "bas-q2-3",
    "bas-q2-4",
    "bas-q2-1"
  ]);
  assert.deepEqual(state.unusedChunks, []);
});

test("duplicate chunk texts consume distinct option ids in option order", () => {
  const state = buildBasReviewQuestionState({
    optionsText: chunks("the", "cat", "the"),
    questionId: "bas-q3",
    submittedOrderText: chunks("the", "the")
  });
  assert.deepEqual(state.placedChunks.map((chunk) => chunk.id), ["bas-q3-0", "bas-q3-2"]);
  assert.deepEqual(state.unusedChunks.map((chunk) => chunk.id), ["bas-q3-1"]);
});

test("missing, empty, and unanswered submissions leave every option in the tray", () => {
  for (const submittedOrderText of ["", "[]", null, undefined]) {
    const state = buildBasReviewQuestionState({
      optionsText: chunks("alpha", "beta"),
      questionId: "bas-q4",
      submittedOrderText
    });
    assert.deepEqual(state.placedChunks, []);
    assert.deepEqual(state.unusedChunks.map((chunk) => chunk.id), ["bas-q4-0", "bas-q4-1"]);
  }
});

test("casing-only differences still map to the canonical option chunk", () => {
  const state = buildBasReviewQuestionState({
    optionsText: chunks("Hello", "World"),
    questionId: "bas-q5",
    submittedOrderText: chunks("world", "hello")
  });
  assert.deepEqual(state.placedChunks.map((chunk) => chunk.id), ["bas-q5-1", "bas-q5-0"]);
  assert.deepEqual(state.placedChunks.map((chunk) => chunk.text), ["World", "Hello"]);
});

test("historical text that no longer matches the canonical options is shown as submitted", () => {
  const state = buildBasReviewQuestionState({
    optionsText: chunks("hello", "world"),
    questionId: "bas-q6",
    submittedOrderText: chunks("hello", "goodbye")
  });
  assert.deepEqual(state.placedChunks.map((chunk) => chunk.text), ["hello", "goodbye"]);
  assert.deepEqual(state.placedChunks.map((chunk) => chunk.id), ["bas-q6-0", "submitted-bas-q6-1"]);
  assert.deepEqual(state.unusedChunks.map((chunk) => chunk.id), ["bas-q6-1"]);
});

test("BAS result opens each question in a readonly drag-state view built from this attempt", () => {
  const resultUi = read("components/PracticeResult.tsx");
  assert.doesNotMatch(resultUi, /questionView/);
  assert.match(resultUi, /buildBasReviewQuestionState\(/);
  assert.match(resultUi, /<QuestionDisplay[\s\S]{0,400}readOnly/);
  assert.match(resultUi, /data-testid="practice-result-question-chips"/);
  assert.match(resultUi, /data-testid="practice-result-readonly-question"/);
  assert.match(resultUi, /data-answer-state=\{answer\.is_correct \? "correct" : "incorrect"\}/);
  assert.match(resultUi, /window\.location\.hash/);
  assert.match(resultUi, /#question-/);
  // The teacher entry passes the answer it was opened for; the shared state
  // initializer must activate that question instead of waiting for a chip click.
  assert.match(resultUi, /useState<string \| null>\(\(\) =>[\s\S]{0,200}initialQuestionId/);
});

test("readonly question header keeps the per-question time from the attempt payload", () => {
  const resultUi = read("components/PracticeResult.tsx");
  assert.match(resultUi, /const activeQuestionTimeSeconds =/);
  assert.match(resultUi, /Number\.isFinite\(activeAnswer\.question_time_seconds\)/);
  assert.match(resultUi, /用时 \{formatDuration\(activeQuestionTimeSeconds\)\}/);
});

test("the BAS result keeps only summary and per-question status chips", () => {
  const resultUi = read("components/PracticeResult.tsx");
  assert.match(resultUi, /ResultSummary/);
  assert.match(resultUi, /practice-result-question-chips/);
  // The old per-question answer-card view is gone for every entry (student and
  // teacher): exactly one result body remains in the shared component.
  assert.doesNotMatch(resultUi, /ResultQuestionCard|只看错题|answerLabel|答题情况/);
});

test("readonly correct answer reuses the teacher question-bank card", () => {
  const resultUi = read("components/PracticeResult.tsx");
  const teacherBank = read("components/TeacherQuestionBank.tsx");
  assert.match(resultUi, /teacher-card border-student-primary-border bg-student-primary-soft\/55 p-5/);
  assert.match(teacherBank, /TeacherCard className="border-student-primary-border bg-student-primary-soft\/55 p-5"/);
  assert.match(resultUi, /正确答案/);
  assert.match(teacherBank, /正确答案/);
  assert.match(resultUi, /final_sentence \|\|/);
  assert.match(teacherBank, /currentQuestion\.final_sentence \|\|/);
  assert.doesNotMatch(resultUi, /Student answer/);
});

test("the readonly path adds no second data load and stays on the cached attempt payload", () => {
  const resultUi = read("components/PracticeResult.tsx");
  const sessionUi = read("components/PracticeSession.tsx");
  const helper = read("lib/basReviewState.ts");
  assert.equal((resultUi.match(/fetch\(/g) ?? []).length, 2);
  assert.match(resultUi, /studentAttemptCacheKey\(attemptId\)/);
  assert.match(sessionUi, /setData\(studentAttemptCacheKey\(payload\.attemptId\)/);
  assert.doesNotMatch(helper, /fetch\(|supabase/i);
});

test("active practice never receives or renders correct-answer fields", () => {
  const sessionUi = read("components/PracticeSession.tsx");
  assert.doesNotMatch(sessionUi, /correct_order_text|final_sentence|正确答案/);
});

test("teacher BAS attempt reuses the exact same result and readonly UI as the student", () => {
  const teacher = read("components/TeacherDashboard.tsx");
  assert.match(teacher, /<PracticeResultView[\s\S]{0,240}initialQuestionId=/);
  assert.match(teacher, /<PracticeResultView[\s\S]{0,240}payload=\{payload\}/);
  // No second BAS detail UI: the old per-question answer-card mode and label
  // are gone from the teacher entry.
  assert.doesNotMatch(teacher, /correctAnswerVisibility="always"/);
  assert.doesNotMatch(teacher, /ResultQuestionCard|只看错题/);
});
