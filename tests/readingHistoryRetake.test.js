const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildReadingHistoryPayload,
  buildReadingResultPayload
} = require("../lib/reading/history.ts");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const historyRoute = read("app/api/reading/history/route.ts");
const resultRoute = read("app/api/reading/results/[attemptId]/route.ts");
const retakeRoute = read("app/api/reading/attempts/[attemptId]/retake/route.ts");
const retakeMigration = read("supabase/reading_history_retake.sql");
const readingHistoryUi = read("components/reading/ReadingHistory.tsx");
const readingResultUi = read("components/reading/ReadingResult.tsx");
const readingPracticeUi = read("components/reading/ReadingPractice.tsx");
const readingRetakeUi = read("components/reading/ReadingRetakeButton.tsx");
const sharedHistoryUi = read("components/shared/PracticeHistoryCards.tsx");
const writingHistoryUi = read("components/writing/WritingSubmissionHistory.tsx");
const basResultUi = read("components/PracticeResult.tsx");
const cache = read("components/StudentDataCache.tsx");

const submittedAttempts = [
  {
    attempt_id: "00000000-0000-4000-8000-000000000001",
    logical_item_id: "RAP-001",
    task_type: "rap",
    elapsed_seconds: 41,
    submitted_at: "2026-08-29T03:00:00.000Z",
    total_points: 3,
    correct_points: 2
  },
  {
    attempt_id: "00000000-0000-4000-8000-000000000002",
    logical_item_id: "RDL-001",
    task_type: "rdl",
    elapsed_seconds: 12,
    submitted_at: "2026-08-29T02:00:00.000Z",
    total_points: 2,
    correct_points: 1
  },
  {
    attempt_id: "00000000-0000-4000-8000-000000000003",
    logical_item_id: "CTW-001",
    task_type: "ctw",
    elapsed_seconds: 5,
    submitted_at: "2026-08-29T01:00:00.000Z",
    total_points: 1,
    correct_points: 0
  }
];

const items = [
  { logical_item_id: "RAP-001", module: "rap", title: "Volcanoes" },
  { logical_item_id: "RDL-001", module: "rdl", title: "Train timetable" },
  { logical_item_id: "CTW-001", module: "ctw", title: null }
];

test("Reading History is own-row, submitted-only, and newest-first", () => {
  assert.match(historyRoute, /requireReadingAttemptStudent/);
  assert.match(historyRoute, /auth\.client[\s\S]*\.from\("reading_attempts"\)/);
  assert.match(historyRoute, /\.eq\("status", "submitted"\)/);
  assert.match(historyRoute, /\.order\("submitted_at", \{ ascending: false \}\)/);
  assert.doesNotMatch(historyRoute, /student_id\s*[:=]|createAnonSupabase\(/);
});

test("History mapper exposes CTW, RDL, and RAP with natural product names", () => {
  const payload = buildReadingHistoryPayload([...submittedAttempts].reverse(), items);
  assert.deepEqual(payload.attempts.map((attempt) => attempt.taskName), [
    "Read an Academic Passage",
    "Read in Daily Life",
    "Complete the Words"
  ]);
  assert.deepEqual(payload.attempts.map((attempt) => attempt.itemTitle), [
    "Volcanoes",
    "Train timetable",
    "Complete the Words"
  ]);
  assert.deepEqual(payload.attempts.map((attempt) => attempt.correctPoints), [2, 1, 0]);
});

test("History mapper drops non-submitted rows and calculates score metadata", () => {
  const payload = buildReadingHistoryPayload([
    ...submittedAttempts,
    { ...submittedAttempts[0], attempt_id: "draft", submitted_at: null }
  ], items);
  assert.equal(payload.attempts.length, 3);
  assert.equal(payload.attempts[0].accuracy, 2 / 3);
  assert.equal(payload.attempts[0].elapsedSeconds, 41);
});

test("submitted Result endpoint checks ownership and status before answer keys", () => {
  const ownershipCheck = resultRoute.indexOf('.from("reading_attempts")');
  const submittedCheck = resultRoute.indexOf('ownedAttempt.status !== "submitted"');
  const serviceRoleRead = resultRoute.indexOf("createServiceSupabase()");
  assert.ok(ownershipCheck > 0 && submittedCheck > ownershipCheck);
  assert.ok(serviceRoleRead > submittedCheck);
  assert.match(resultRoute, /if \(!ownedAttempt\)[\s\S]*status: 404/);
  assert.match(resultRoute, /尚未提交[\s\S]*status: 409/);
});

test("Result endpoint does not read or expose correct-answer content", () => {
  assert.doesNotMatch(resultRoute, /correct_option_id|correct_anchor_id|correct_sentence_id|missing_text|option_text|sentence_text/);
  assert.doesNotMatch(readingResultUi, /正确答案|correctAnswer|correctOptionId|correctAnchorId|correctSentenceId|missingText/);
});

test("CTW historical result maps every slot, including unanswered slots", () => {
  const result = buildReadingResultPayload({
    attempt: { ...submittedAttempts[2], submitted_at: submittedAttempts[2].submitted_at },
    item: items[2],
    answers: [{
      attempt_answer_id: "answer-ctw",
      question_id: "question-ctw",
      slot_id: "slot-1",
      answer_kind: "ctw_slot",
      student_answer: null,
      is_correct: false
    }],
    questions: [{
      question_id: "question-ctw",
      question_order: 1,
      question_type: "ctw"
    }],
    ctwParagraphs: [{ question_id: "question-ctw", paragraph_id: "paragraph-1", paragraph_order: 1 }],
    ctwSegments: [
      { question_id: "question-ctw", paragraph_id: "paragraph-1", segment_order: 1, segment_type: "text", text_content: "An organiz", slot_id: null },
      { question_id: "question-ctw", paragraph_id: "paragraph-1", segment_order: 2, segment_type: "blank", text_content: null, slot_id: "slot-1" },
      { question_id: "question-ctw", paragraph_id: "paragraph-1", segment_order: 3, segment_type: "text", text_content: " can help.", slot_id: null }
    ],
    slots: [{ question_id: "question-ctw", slot_id: "slot-1", slot_order: 1, prefix: "" }]
  });
  assert.deepEqual(result.answers[0], {
    answerId: "answer-ctw",
    order: 1,
    isAnswered: false,
    isCorrect: false,
    questionId: "question-ctw",
    questionTimeSeconds: null
  });
  assert.deepEqual(result.ctwParagraphs[0].segments[1], {
    kind: "blank",
    answerId: "answer-ctw",
    isAnswered: false,
    isCorrect: false,
    order: 1,
    prefix: "",
    studentAnswer: ""
  });
});

test("RDL historical result exposes only state metadata", () => {
  const result = buildChoiceResult("rdl");
  assert.equal(result.answers[0].isAnswered, true);
  assert.equal(result.answers[0].isCorrect, false);
  assert.equal(result.answers[0].order, 1);
  assert.equal("studentAnswer" in result.answers[0], false);
});

test("RAP historical result exposes the same state-only contract", () => {
  const result = buildChoiceResult("rap");
  assert.equal(result.answers[0].questionId, "question-rap");
  assert.equal(result.answers[0].questionTimeSeconds, null);
});

test("RAP unanswered state is distinct from incorrect", () => {
  const result = buildReadingResultPayload({
    attempt: onePointRapAttempt(),
    item: items[0],
    answers: [{
      attempt_answer_id: "answer-insertion",
      question_id: "question-insertion",
      slot_id: null,
      answer_kind: "insertion_anchor",
      student_answer: null,
      is_correct: false
    }],
    questions: [rapQuestion({ question_id: "question-insertion" })]
  });
  assert.equal(result.answers[0].isAnswered, false);
  assert.equal(result.answers[0].isCorrect, false);
});

test("Result mapper refuses incomplete persisted answer detail", () => {
  assert.throws(() => buildReadingResultPayload({
    attempt: onePointRapAttempt(),
    item: items[0],
    answers: [],
    questions: [],
    slots: []
  }), /READING_RESULT_ANSWER_COUNT_MISMATCH/);
});

test("Retake validates an owned submitted source and never mutates it", () => {
  assert.match(retakeMigration, /attempt\.student_id = v_user_id/);
  assert.match(retakeMigration, /attempt\.status = 'submitted'/);
  assert.match(retakeMigration, /for update/);
  assert.match(retakeMigration, /insert into public\.reading_attempts/);
  assert.doesNotMatch(retakeMigration, /update public\.reading_attempts|delete from public\.reading_attempts/);
  assert.match(retakeRoute, /requireReadingAttemptStudent/);
  assert.doesNotMatch(retakeRoute, /studentId|logicalItemId/);
});

test("Retake resumes the one existing draft and is concurrency-idempotent", () => {
  assert.match(retakeMigration, /attempt\.status = 'draft'[\s\S]*limit 1/);
  assert.match(retakeMigration, /on conflict \(student_id, logical_item_id, task_type\)[\s\S]*where status = 'draft'[\s\S]*do nothing/);
  assert.match(retakeMigration, /'created', v_created[\s\S]*'resumed', not v_created/);
  assert.match(readingRetakeUi, /if \(loading\) return/);
  assert.match(readingRetakeUi, /disabled=\{loading\}/);
});

test("Reading History and Writing History share one submission-card implementation", () => {
  assert.match(sharedHistoryUi, /export function PracticeSubmissionHistoryHeader/);
  assert.match(sharedHistoryUi, /export function PracticeSubmissionHistoryList/);
  assert.match(readingHistoryUi, /PracticeSubmissionHistoryHeader/);
  assert.match(readingHistoryUi, /PracticeSubmissionHistoryList/);
  assert.match(writingHistoryUi, /PracticeSubmissionHistoryHeader/);
  assert.match(writingHistoryUi, /PracticeSubmissionHistoryList/);
});

test("Reading Result and BAS Result share PracticeResultSummary", () => {
  assert.match(basResultUi, /export function PracticeResultSummary/);
  assert.match(readingResultUi, /PracticeResultSummary/);
  assert.match(readingResultUi, /<PracticeResultSummary/);
  assert.doesNotMatch(readingResultUi, /ResultMetricCard|function ResultSummary/);
});

test("Reading result labels use the unified numbered-question wording", () => {
  assert.match(readingResultUi, /第\{answer\.order\}题/);
  assert.doesNotMatch(readingResultUi, /填写位置/);
});

test("submit invalidates Reading caches and unified History before opening the official result", () => {
  assert.match(cache, /STUDENT_READING_HISTORY_CACHE_PREFIX = "reading:history"/);
  assert.match(cache, /STUDENT_READING_RESULT_CACHE_PREFIX = "reading:result"/);
  assert.match(readingPracticeUi, /invalidate\(STUDENT_READING_HISTORY_CACHE_PREFIX\)/);
  assert.match(readingPracticeUi, /invalidate\(STUDENT_PRACTICE_HISTORY_CACHE_PREFIX\)/);
  assert.match(readingPracticeUi, /router\.replace\(`\/student\/reading\/results\/\$\{encodeURIComponent\(result\.attempt\.attemptId\)\}`\)/);
  assert.doesNotMatch(readingPracticeUi, /setAttempt\(result\.attempt\)/);
  assert.doesNotMatch(readingPracticeUi, /if \(attempt\.status === "submitted"\)[\s\S]*PracticeResultSummary/);
  assert.doesNotMatch(readingPracticeUi, /invalidate\(STUDENT_SETS_CACHE|clear\(\)/);
});

test("History and Result UI provide Back, loading, error, empty, view, and retake behavior", () => {
  assert.match(readingHistoryUi, /StudentNavigation/);
  assert.match(readingHistoryUi, /StudentLoadingState/);
  assert.match(readingHistoryUi, /StudentErrorState/);
  assert.match(readingHistoryUi, /StudentEmptyState/);
  assert.match(readingHistoryUi, /查看结果/);
  assert.match(readingHistoryUi, /ReadingRetakeButton/);
  assert.match(readingResultUi, /backHref=\{STUDENT_ROUTES\.practiceHistory\}/);
  assert.match(readingResultUi, /ReadingRetakeButton/);
  assert.doesNotMatch(readingHistoryUi, />\{attempt\.attemptId\}<|>\{attempt\.logicalItemId\}</);
});

function buildChoiceResult(module) {
  const base = module === "rdl" ? submittedAttempts[1] : onePointRapAttempt();
  return buildReadingResultPayload({
    attempt: { ...base, total_points: 1, correct_points: 0, submitted_at: base.submitted_at },
    item: module === "rdl" ? items[1] : items[0],
    answers: [{
      attempt_answer_id: `answer-${module}`,
      question_id: `question-${module}`,
      slot_id: null,
      answer_kind: "option",
      student_answer: "option-1",
      is_correct: false
    }],
    questions: [{
      question_id: `question-${module}`,
      question_order: 1,
      question_type: module === "rdl" ? "rdl" : "rap_multiple_choice"
    }]
  });
}

function onePointRapAttempt() {
  return {
    ...submittedAttempts[0],
    total_points: 1,
    correct_points: 0,
    submitted_at: submittedAttempts[0].submitted_at
  };
}

function rapQuestion(overrides) {
  return {
    question_id: "question-rap",
    question_order: 1,
    question_type: "rap_sentence_selection",
    ...overrides
  };
}
