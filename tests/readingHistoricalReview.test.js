const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const {
  READING_LOOKUP_CAPABILITIES,
  readingLookupEnabled
} = require("../lib/reading/lookupCapabilities.ts");
const { buildSubmittedReadingAnswerState } = require("../lib/reading/review.ts");
const { toStudentReadingPracticePayload } = require("../lib/reading/studentPractice.ts");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const practiceUi = read("components/reading/ReadingPractice.tsx");
const resultUi = read("components/reading/ReadingResult.tsx");
const reviewRoute = read("app/api/reading/attempts/[attemptId]/review/route.ts");
const reviewPage = read("app/student/reading/results/[attemptId]/questions/[questionIndex]/page.tsx");
const retakeMigration = read("supabase/reading_history_retake.sql");
const fixture = JSON.parse(read("data/reading/fixtures/reading-source.fixture.json"));
const packages = groupReadingSourceOccurrences(fixture.occurrences).packages;

function practiceFor(taskType) {
  return toStudentReadingPracticePayload(structuredClone(
    packages.find((candidate) => candidate.item.module === taskType)
  ));
}

test("submitted review maps CTW, choice, insertion, and sentence answers into shared practice state", () => {
  const ctw = practiceFor("ctw");
  const ctwQuestion = ctw.questions[0];
  const ctwRows = ctwQuestion.slots.map((slot, index) => ({
    answer_kind: "ctw_slot",
    question_id: ctwQuestion.questionId,
    slot_id: slot.slotId,
    student_answer: index === 0 ? "abc" : null
  }));
  const ctwState = buildSubmittedReadingAnswerState(ctw, ctwRows);
  assert.equal(ctwState[ctwQuestion.questionId].kind, "ctw");
  assert.equal(ctwState[ctwQuestion.questionId].slots[ctwQuestion.slots[0].slotId].join(""), "abc");

  const rdl = practiceFor("rdl");
  const rdlQuestion = rdl.questions[0];
  const rdlState = buildSubmittedReadingAnswerState(rdl, [{
    answer_kind: "option",
    question_id: rdlQuestion.questionId,
    slot_id: null,
    student_answer: rdlQuestion.options[1].optionId
  }]);
  assert.deepEqual(rdlState[rdlQuestion.questionId], { kind: "choice", optionId: rdlQuestion.options[1].optionId });

  const rap = practiceFor("rap");
  const [choice, insertion, selection] = rap.questions;
  const selectedSentence = rap.passage.paragraphs.find(
    (paragraph) => paragraph.paragraphId === selection.targetParagraphId
  ).sentences[0].sentenceId;
  const rapState = buildSubmittedReadingAnswerState(rap, [
    { answer_kind: "option", question_id: choice.questionId, slot_id: null, student_answer: choice.options[0].optionId },
    { answer_kind: "insertion_anchor", question_id: insertion.questionId, slot_id: null, student_answer: insertion.anchors[2].anchorId },
    { answer_kind: "sentence_selection", question_id: selection.questionId, slot_id: null, student_answer: selectedSentence }
  ]);
  assert.equal(rapState[insertion.questionId].anchorId, insertion.anchors[2].anchorId);
  assert.equal(rapState[selection.questionId].sentenceId, selectedSentence);
});

test("historical review route is owned submitted-only GET data with no mutation surface", () => {
  const ownership = reviewRoute.indexOf('.from("reading_attempts")');
  const submitted = reviewRoute.indexOf('ownedAttempt.status !== "submitted"');
  const serviceRole = reviewRoute.indexOf("createServiceSupabase()");
  assert.ok(ownership > 0 && submitted > ownership && serviceRole > submitted);
  assert.match(reviewRoute, /loadStudentReadingPractice/);
  assert.match(reviewRoute, /buildSubmittedReadingAnswerState/);
  assert.doesNotMatch(reviewRoute, /export async function (POST|PUT|PATCH|DELETE)|\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
});

test("result chip route keeps submitted attempt id plus zero-based question index", () => {
  assert.match(resultUi, /href=\{`\/student\/reading\/results\/\$\{encodeURIComponent\(attemptId\)\}\/questions\/\$\{questionIndex\}`\}/);
  assert.match(reviewPage, /params: \{ attemptId: string; questionIndex: string \}/);
  assert.match(reviewPage, /ReadingSubmittedReview/);
});

test("submitted review reuses ReadingPractice shell while suppressing every answer mutation and Submit", () => {
  const reviewLoader = practiceUi.slice(
    practiceUi.indexOf("export function ReadingSubmittedReview"),
    practiceUi.indexOf("function ReadingPracticeShell")
  );
  assert.match(reviewLoader, /mode="submitted_review"/);
  assert.match(reviewLoader, /\/review`/);
  assert.doesNotMatch(reviewLoader, /method: "(POST|PUT|PATCH|DELETE)"/);
  assert.match(practiceUi, /if \(readOnly\) return;[\s\S]*setAnswers/);
  assert.match(practiceUi, /disabled=\{readOnly\}/);
  assert.match(practiceUi, /onClick=\{readOnly \? undefined/);
  assert.match(practiceUi, /if \(module === "ctw" && !readOnly\)/);
  assert.match(practiceUi, /readOnly \? \([\s\S]*disabled=\{!canGoNext\}/);
  assert.doesNotMatch(reviewLoader, /只读|Readonly|历史模式|Review mode/i);
});

test("active lookup is disabled and submitted historical lookup is enabled for every Reading module", () => {
  assert.deepEqual(READING_LOOKUP_CAPABILITIES.active, { ctw: false, rdl: false, rap: false });
  assert.deepEqual(READING_LOOKUP_CAPABILITIES.submitted_review, { ctw: true, rdl: true, rap: true });
  for (const taskType of ["ctw", "rdl", "rap"]) {
    assert.equal(readingLookupEnabled("active", taskType), false);
    assert.equal(readingLookupEnabled("submitted_review", taskType), true);
  }
  assert.match(practiceUi, /function DomTextLookupRegion/);
  assert.match(practiceUi, /window\.getSelection\(\)/);
  assert.match(practiceUi, /range\.startContainer/);
  assert.match(practiceUi, /range\.endContainer/);
  assert.match(practiceUi, /id="dom-lookup-query"/);
  assert.match(practiceUi, /data-testid="dom-lookup-panel"/);
  assert.match(practiceUi, /document\.addEventListener\("pointerdown", closeOnOutsidePointer, true\)/);
});

test("retake still creates or resumes a draft without overwriting the submitted source", () => {
  assert.match(retakeMigration, /insert into public\.reading_attempts/);
  assert.doesNotMatch(retakeMigration, /update public\.reading_attempts|delete from public\.reading_attempts/);
});
