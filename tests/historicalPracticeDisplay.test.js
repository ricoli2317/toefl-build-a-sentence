const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createHistoricalPracticeDisplayResolver,
  enrichBuildSentenceHistoricalAttempts
} = require("../lib/historicalPracticeDisplay.ts");
const { buildPracticeHistoryPayload } = require("../lib/practiceHistory.ts");
const { buildWritingSubmissionHistory } = require("../lib/writingSubmissionHistory.ts");

const projectRoot = path.resolve(__dirname, "..");

function item(itemId, taskType, displayNumber, displayTitle = null, isActive = true) {
  return {
    item_id: itemId,
    task_type: taskType,
    display_number: displayNumber,
    display_title: displayTitle,
    is_active: isActive
  };
}

function source(sourceId, itemId, taskType, rawId) {
  return {
    source_id: sourceId,
    item_id: itemId,
    task_type: taskType,
    source_set_id: taskType === "build_sentence" ? rawId : null,
    source_question_id: taskType === "build_sentence" ? null : rawId
  };
}

function resolver(displayNumber = "057B") {
  return createHistoricalPracticeDisplayResolver({
    items: [
      item("bas-item", "build_sentence", displayNumber),
      item("email-item", "email", "021", "Request for Schedule Change"),
      item("ad-item", "academic_discussion", "018", "Nature vs Nurture"),
      item("inactive-item", "email", "022", "Archived Prompt", false)
    ],
    sources: [
      source("bas-a", "bas-item", "build_sentence", "raw-a"),
      source("bas-b", "bas-item", "build_sentence", "raw-b"),
      source("bas-c", "bas-item", "build_sentence", "raw-c"),
      source("email-a", "email-item", "email", "email-a"),
      source("email-b", "email-item", "email", "email-b"),
      source("ad-a", "ad-item", "academic_discussion", "ad-a"),
      source("inactive", "inactive-item", "email", "email-inactive")
    ]
  });
}

function basAttempt(attemptId, setId, submittedAt) {
  return {
    attemptId,
    setId,
    setTitle: `${setId} raw title`,
    correctCount: 1,
    totalQuestions: 1,
    timeSpentSeconds: 10,
    submittedAt
  };
}

test("BAS A/B/C attempts remain three exact histories with the same current logical name", () => {
  const attempts = [
    basAttempt("attempt-a", "raw-a", "2026-05-01T00:00:00Z"),
    basAttempt("attempt-b", "raw-b", "2026-06-01T00:00:00Z"),
    basAttempt("attempt-c", "raw-c", "2026-07-01T00:00:00Z")
  ];
  const enriched = enrichBuildSentenceHistoricalAttempts(attempts, resolver());
  assert.equal(enriched.length, 3);
  assert.deepEqual(enriched.map(({ attemptId }) => attemptId), ["attempt-a", "attempt-b", "attempt-c"]);
  assert.deepEqual(enriched.map(({ setId }) => setId), ["raw-a", "raw-b", "raw-c"]);
  assert.deepEqual(enriched.map(({ setTitle }) => setTitle), ["套题057B", "套题057B", "套题057B"]);
});

test("a display_number correction changes history naming without changing attempt identity", () => {
  const attempts = [basAttempt("attempt-fixed", "raw-a", "2026-05-01T00:00:00Z")];
  assert.equal(enrichBuildSentenceHistoricalAttempts(attempts, resolver("060"))[0].setTitle, "套题060");
  const corrected = enrichBuildSentenceHistoricalAttempts(attempts, resolver("057B"))[0];
  assert.equal(corrected.attemptId, "attempt-fixed");
  assert.equal(corrected.setId, "raw-a");
  assert.equal(corrected.setTitle, "套题057B");
});

test("BAS historical result keeps exact attempt and raw questions while changing only display title", () => {
  const route = fs.readFileSync(path.join(projectRoot, "app/api/attempts/[attemptId]/route.ts"), "utf8");
  assert.match(route, /\.eq\("attempt_id", params\.attemptId\)/);
  assert.match(route, /\.eq\("attempt_id", params\.attemptId\)[\s\S]*\.order\("question_order"/);
  assert.match(route, /set_title: historicalDisplay\.displayName/);
  assert.match(route, /questionById\.get\(String\(answer\.question_id\)\)/);
});

test("Grammar and Wrongbook virtual histories keep their existing names", () => {
  const historicalResolver = resolver();
  const grammar = historicalResolver.resolveBuildSentence({
    fallbackDisplayName: "Grammar Practice · Clauses",
    rawSetId: "grammar-all-clauses"
  });
  const wrongbook = historicalResolver.resolveBuildSentence({
    fallbackDisplayName: "历史错题合集",
    rawSetId: "wrongbook-all-student"
  });
  assert.deepEqual([grammar.displayName, grammar.resolution], ["Grammar Practice · Clauses", "virtual"]);
  assert.deepEqual([wrongbook.displayName, wrongbook.resolution], ["历史错题合集", "virtual"]);
  assert.equal(grammar.warning, null);
  assert.equal(wrongbook.warning, null);
});

test("duplicate raw writing submissions remain independent but share logical display", () => {
  const historicalResolver = resolver();
  const submissions = ["email-a", "email-b"].map((rawQuestionId, index) => ({
    attemptId: `writing-${index + 1}`,
    rawQuestionId,
    display: historicalResolver.resolveWritingAttempt({
      assignmentId: null,
      fallbackDisplayName: `raw ${index + 1}`,
      rawQuestionId,
      taskType: "email"
    })
  }));
  assert.deepEqual(submissions.map(({ attemptId }) => attemptId), ["writing-1", "writing-2"]);
  assert.deepEqual(submissions.map(({ rawQuestionId }) => rawQuestionId), ["email-a", "email-b"]);
  assert.deepEqual(submissions.map(({ display }) => display.displayName), [
    "题目021 Request for Schedule Change",
    "题目021 Request for Schedule Change"
  ]);
});

test("free writing uses logical display while exact historical question content is untouched", () => {
  const exactQuestion = {
    question_id: "email-b",
    set_title: "8.18 raw B",
    subject: "Exact historical B subject"
  };
  const display = resolver().resolveWritingAttempt({
    assignmentId: null,
    fallbackDisplayName: exactQuestion.set_title,
    rawQuestionId: exactQuestion.question_id,
    taskType: "email"
  });
  assert.equal(display.displayName, "题目021 Request for Schedule Change");
  assert.deepEqual(exactQuestion, {
    question_id: "email-b",
    set_title: "8.18 raw B",
    subject: "Exact historical B subject"
  });
});

test("question-bank assignment keeps Assignment primary context and exposes logical auxiliary display", () => {
  const display = resolver().resolveWritingAttempt({
    assignmentId: "assignment-1",
    assignmentDisplayName: "Weekly Assignment Snapshot",
    fallbackDisplayName: "raw title",
    questionSource: "question_bank",
    rawQuestionId: "email-a",
    taskType: "email"
  });
  assert.equal(display.resolution, "assignment");
  assert.equal(display.displayName, "Weekly Assignment Snapshot");
  assert.equal(display.logicalDisplayName, "题目021 Request for Schedule Change");
  assert.equal(display.rawQuestionId, "email-a");
});

test("custom assignment has no logical item or number", () => {
  const display = resolver().resolveWritingAttempt({
    assignmentId: "assignment-custom",
    assignmentDisplayName: "Teacher Custom Prompt",
    fallbackDisplayName: "custom raw",
    questionSource: "custom",
    rawQuestionId: "custom:assignment-custom",
    taskType: "email"
  });
  assert.equal(display.displayName, "Teacher Custom Prompt");
  assert.equal(display.logicalDisplayName, null);
  assert.equal(display.itemId, null);
  assert.equal(display.displayNumber, null);
});

test("inactive historical item remains resolvable", () => {
  const display = resolver().resolveWritingAttempt({
    assignmentId: null,
    fallbackDisplayName: "old raw title",
    rawQuestionId: "email-inactive",
    taskType: "email"
  });
  assert.equal(display.displayName, "题目022 Archived Prompt");
  assert.equal(display.isActive, false);
  assert.equal(display.resolution, "logical");
});

test("orphan history falls back to raw name with a structured warning", () => {
  const display = resolver().resolveWritingAttempt({
    assignmentId: null,
    fallbackDisplayName: "orphan raw title",
    rawQuestionId: "orphan-question",
    taskType: "academic_discussion"
  });
  assert.equal(display.displayName, "orphan raw title");
  assert.equal(display.resolution, "fallback");
  assert.deepEqual(display.warning, {
    code: "HISTORICAL_SOURCE_NOT_MAPPED",
    taskType: "academic_discussion",
    rawSetId: null,
    rawQuestionId: "orphan-question",
    itemId: null,
    message: "Historical raw source has no practice_item_sources mapping."
  });
});

test("BAS and writing history sorting remains actual attempt/submission time", () => {
  const bas = buildPracticeHistoryPayload({
    attempts: [
      basAttempt("old", "raw-a", "2026-08-01T00:00:00Z"),
      basAttempt("new", "raw-b", "2026-08-03T00:00:00Z")
    ],
    answers: [],
    correctionAnswers: [],
    todayStart: Date.parse("2026-08-10T00:00:00Z"),
    todayEnd: Date.parse("2026-08-11T00:00:00Z")
  });
  assert.deepEqual(bas.attempts.map(({ attemptId }) => attemptId), ["new", "old"]);

  const writing = buildWritingSubmissionHistory([
    { attempt_id: "old", submitted_at: "2026-08-01T00:00:00Z", word_count: 1, writing_mode: "exam", elapsed_seconds: 1 },
    { attempt_id: "new", submitted_at: "2026-08-03T00:00:00Z", word_count: 1, writing_mode: "exam", elapsed_seconds: 1 }
  ], new Set());
  assert.deepEqual(writing.map(({ attempt_id }) => attempt_id), ["new", "old"]);
});

test("history React keys and URLs keep attempt_id rather than display_number", () => {
  const basUi = fs.readFileSync(path.join(projectRoot, "components/AttemptHistoryList.tsx"), "utf8");
  const writingUi = fs.readFileSync(path.join(projectRoot, "components/writing/WritingSubmissionHistory.tsx"), "utf8");
  assert.match(writingUi, /key=\{attempt\.attempt_id\}/);
  assert.match(writingUi, /encodeURIComponent\(attempt\.attempt_id\)/);
  assert.doesNotMatch(writingUi, /key=\{[^}]*display_number/);
  assert.match(basUi, /attemptId/);
});

test("Dashboard and student review list consume logical display_name without replacing raw set_title", () => {
  const dashboard = fs.readFileSync(path.join(projectRoot, "components/student/StudentDashboard.tsx"), "utf8");
  const reviewUi = fs.readFileSync(path.join(projectRoot, "components/student/StudentWritingReview.tsx"), "utf8");
  const reviewRoute = fs.readFileSync(path.join(projectRoot, "app/api/writing/reviews/route.ts"), "utf8");
  assert.match(dashboard, /draft\.display_name \?\? draft\.set_title/);
  assert.match(reviewUi, /review\.display_name \?\? review\.set_title/);
  assert.match(reviewRoute, /set_title: setTitle/);
  assert.match(reviewRoute, /display_name: display\.displayName/);
  assert.match(reviewRoute, /assignmentDisplayName: setTitle/);
});

test("historical resolver loads items and sources in two batched table reads, not per history row", () => {
  const helper = fs.readFileSync(path.join(projectRoot, "lib/historicalPracticeDisplay.ts"), "utf8");
  assert.match(helper, /Promise\.all\(\[/);
  assert.equal((helper.match(/\.from\("practice_items"\)/g) ?? []).length, 1);
  assert.equal((helper.match(/\.from\("practice_item_sources"\)/g) ?? []).length, 1);
  assert.doesNotMatch(helper, /for \([^)]*(attempt|submission)[^)]*\)[\s\S]{0,200}\.from\(/i);
});
