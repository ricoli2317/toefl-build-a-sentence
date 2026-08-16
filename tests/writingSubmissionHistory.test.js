const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  safeWritingReviewReturnTo,
  writingReviewResultHref,
  writingSubmissionHistoryHref
} = require("../lib/studentNavigation.ts");
const {
  buildWritingSubmissionHistory,
  loadWritingSubmissionHistory
} = require("../lib/writingSubmissionHistory.ts");

test("safe returnTo is callable from lib and preserves only normalized student paths", () => {
  assert.equal(
    safeWritingReviewReturnTo("/student/write-email/submission/attempt-1?mode=readonly#essay"),
    "/student/write-email/submission/attempt-1?mode=readonly#essay"
  );
  assert.equal(
    safeWritingReviewReturnTo(["/student/writing-reviews", "/student/sets"]),
    "/student/writing-reviews"
  );
  for (const unsafe of [
    "https://evil.example/student/sets",
    "//evil.example/student/sets",
    "/student/../../teacher/writing",
    "/student\\..\\teacher",
    "/teacher/writing"
  ]) {
    assert.equal(safeWritingReviewReturnTo(unsafe), "/student/writing-reviews");
  }
  assert.equal(safeWritingReviewReturnTo(undefined), "/student/writing-reviews");
});

test("review and submission-history hrefs retain concrete IDs", () => {
  assert.equal(
    writingReviewResultHref("attempt A", "/student/write-email/submissions/question-1"),
    "/student/writing-reviews/attempt%20A?returnTo=%2Fstudent%2Fwrite-email%2Fsubmissions%2Fquestion-1"
  );
  assert.equal(
    writingSubmissionHistoryHref("email", "question A"),
    "/student/write-email/submissions/question%20A"
  );
  assert.equal(
    writingSubmissionHistoryHref("academic_discussion", "discussion-1"),
    "/student/academic-discussion/submissions/discussion-1"
  );
});

test("two attempts for one question remain independent and sort newest first", () => {
  const history = buildWritingSubmissionHistory(
    [
      { attempt_id: "attempt-A", submitted_at: "2026-08-13T12:40:00.000Z", word_count: 86 },
      { attempt_id: "attempt-B", submitted_at: "2026-08-13T13:12:00.000Z", word_count: 191 }
    ],
    new Set(["attempt-B"])
  );
  assert.deepEqual(history.map((attempt) => attempt.attempt_id), ["attempt-B", "attempt-A"]);
  assert.deepEqual(history.map((attempt) => attempt.word_count), [191, 86]);
  assert.equal(history[0].has_published_review, true);
  assert.equal(history[1].has_published_review, false);
});

test("equal submission times use attempt_id as a stable descending tiebreaker", () => {
  const submitted_at = "2026-08-13T13:12:00.000Z";
  const history = buildWritingSubmissionHistory(
    [
      { attempt_id: "attempt-A", submitted_at, word_count: 86 },
      { attempt_id: "attempt-C", submitted_at, word_count: 120 },
      { attempt_id: "attempt-B", submitted_at, word_count: 191 }
    ],
    new Set()
  );
  assert.deepEqual(
    history.map((attempt) => attempt.attempt_id),
    ["attempt-C", "attempt-B", "attempt-A"]
  );
});

test("history loader scopes attempts to the current user and keeps retakes", async () => {
  const calls = [];
  const repository = {
    async findOwnedSubmittedAttempts(input) {
      calls.push(["attempts", input]);
      return {
        data: [
          { attempt_id: "attempt-old", submitted_at: "2026-08-13T12:40:00.000Z", word_count: 86 },
          { attempt_id: "attempt-new", submitted_at: "2026-08-13T13:12:00.000Z", word_count: 191 }
        ],
        error: null
      };
    },
    async findPublishedAttemptIds(attemptIds) {
      calls.push(["reviews", attemptIds]);
      return { data: ["attempt-new"], error: null };
    },
    async findQuestion(input) {
      calls.push(["question", input]);
      return {
        data: { question_id: input.questionId, set_title: "5.3A", year_month: "202608" },
        error: null
      };
    }
  };
  const payload = await loadWritingSubmissionHistory(
    { userId: "student-1", taskType: "email", questionId: "question-1" },
    repository
  );
  assert.deepEqual(payload.attempts.map((attempt) => attempt.attempt_id), ["attempt-new", "attempt-old"]);
  assert.deepEqual(calls[0], ["attempts", {
    userId: "student-1",
    taskType: "email",
    questionId: "question-1"
  }]);
  assert.deepEqual(calls[2], ["reviews", ["attempt-old", "attempt-new"]]);
});

test("history UI links every row by its own attempt_id and gates review action", () => {
  const historySource = read("components/writing/WritingSubmissionHistory.tsx");
  assert.match(historySource, /attempt\.attempt_id/);
  assert.match(historySource, /attempt\.has_published_review/);
  assert.match(historySource, /查看提交/);
  assert.match(historySource, /查看批改/);
  assert.match(historySource, /writingReviewResultHref\(attempt\.attempt_id/);
  assert.equal(historySource.includes("latest"), false);
});

test("catalog uses a history entry for multiple submissions and direct entry for one", () => {
  const catalogSource = read("components/writing/WritingCatalog.tsx");
  assert.match(catalogSource, /submitted_attempt_count > 1/);
  assert.match(catalogSource, /查看提交记录/);
  assert.match(catalogSource, /submittedHistoryAction \?\? submissionAction/);
});

test("readonly GET and UI use the requested attempt and minimal published flag", () => {
  const routeSource = read("app/api/writing/attempts/[attemptId]/route.ts");
  const practiceSource = read("components/writing/WritingPractice.tsx");
  assert.match(routeSource, /params\.attemptId/);
  assert.match(routeSource, /readOwnedWritingAttempt/);
  assert.match(routeSource, /has_published_review/);
  assert.match(practiceSource, /\/api\/writing\/attempts\/\$\{encodeURIComponent\(attemptId\)\}/);
  assert.match(practiceSource, /payload\.has_published_review === true/);
  assert.match(practiceSource, /writingReviewResultHref\(\s*attempt\.attempt_id/);
});

test("published review list remains attempt-level and does not deduplicate by question", () => {
  const listRoute = read("app/api/writing/reviews/route.ts");
  assert.match(listRoute, /attempt_id: attempt\.attempt_id/);
  assert.match(listRoute, /publishedByAttempt\.has\(attempt\.attempt_id\)/);
  assert.equal(listRoute.includes("new Map(attempts.map((attempt) => [attempt.question_id"), false);
});

test("history API explicitly filters current user, task, question, and submitted status", () => {
  const routeSource = read("app/api/writing/submissions/route.ts");
  assert.match(routeSource, /\.eq\("user_id", userId\)/);
  assert.match(routeSource, /\.eq\("task_type", taskType\)/);
  assert.match(routeSource, /\.eq\("question_id", questionId\)/);
  assert.match(routeSource, /\.eq\("status", "submitted"\)/);
  assert.match(routeSource, /\.order\("submitted_at", \{ ascending: false \}\)/);
  assert.match(routeSource, /\.order\("attempt_id", \{ ascending: false \}\)/);
});

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}
