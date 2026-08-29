const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildUnifiedPracticeHistory
} = require("../lib/unifiedPracticeHistory.ts");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function fixture(overrides = {}) {
  return buildUnifiedPracticeHistory({
    basAttempts: [
      {
        attempt_id: "bas-1",
        set_id: "bas-set",
        set_title: "BAS fallback",
        correct_count: 8,
        total_questions: 10,
        time_spent_seconds: 75,
        submitted_at: "2026-08-29T06:00:00.000Z"
      },
      {
        attempt_id: "bas-draft",
        set_id: "bas-set",
        set_title: "BAS fallback",
        correct_count: 0,
        total_questions: 10,
        time_spent_seconds: 5,
        submitted_at: null
      },
      {
        attempt_id: "wrongbook-submitted",
        set_id: "wrongbook-history",
        set_title: "错题订正",
        correct_count: 1,
        total_questions: 1,
        time_spent_seconds: 5,
        submitted_at: "2026-08-29T07:00:00.000Z"
      }
    ],
    basTitles: new Map([["bas-set", "套题 101"]]),
    category: "all",
    limit: 20,
    offset: 0,
    readingAttempts: [
      {
        attempt_id: "ctw-1",
        logical_item_id: "ctw-item",
        task_type: "ctw",
        status: "submitted",
        elapsed_seconds: 15,
        submitted_at: "2026-08-29T03:00:00.000Z",
        total_points: 10,
        correct_points: 8
      },
      {
        attempt_id: "rdl-1",
        logical_item_id: "rdl-item",
        task_type: "rdl",
        status: "submitted",
        elapsed_seconds: 98,
        submitted_at: "2026-08-29T04:00:00.000Z",
        total_points: 2,
        correct_points: 0
      },
      {
        attempt_id: "rap-1",
        logical_item_id: "rap-item",
        task_type: "rap",
        status: "submitted",
        elapsed_seconds: 226,
        submitted_at: "2026-08-29T05:00:00.000Z",
        total_points: 5,
        correct_points: 4
      },
      {
        attempt_id: "reading-draft",
        logical_item_id: "rap-item",
        task_type: "rap",
        status: "draft",
        elapsed_seconds: 1,
        submitted_at: null,
        total_points: 5,
        correct_points: 0
      }
    ],
    readingTitles: new Map([
      ["ctw-item", "套题 097"],
      ["rdl-item", "BRIDGEFORD UNIVERSITY MUSIC & CULTURE NIGHT"],
      ["rap-item", "Optical Astronomy’s Adaptive Revolution"]
    ]),
    taskType: "all",
    todayStart: Date.parse("2026-08-29T00:00:00.000Z"),
    todayEnd: Date.parse("2026-08-30T00:00:00.000Z"),
    writingAttempts: [
      {
        attempt_id: "email-1",
        assignment_id: null,
        question_id: "email-question",
        task_type: "email",
        status: "submitted",
        word_count: 186,
        elapsed_seconds: 402,
        submitted_at: "2026-08-29T02:00:00.000Z"
      },
      {
        attempt_id: "discussion-1",
        assignment_id: null,
        question_id: "discussion-question",
        task_type: "academic_discussion",
        status: "submitted",
        word_count: 142,
        elapsed_seconds: 492,
        submitted_at: "2026-08-28T23:00:00.000Z"
      },
      {
        attempt_id: "writing-draft",
        assignment_id: null,
        question_id: "email-question",
        task_type: "email",
        status: "draft",
        word_count: 20,
        elapsed_seconds: 10,
        submitted_at: null
      }
    ],
    writingReviews: new Map([["email-1", { officialScore: 4 }]]),
    writingTitles: new Map([
      ["email:email-question", "Costume Rental Inquiry"],
      ["academic_discussion:discussion-question", "Workplace Multitasking"]
    ]),
    ...overrides
  });
}

test("aggregates all six task types, excludes drafts/virtual attempts, and sorts newest first", () => {
  const payload = fixture();
  assert.deepEqual(payload.records.map((record) => record.taskType), [
    "build_sentence",
    "rap",
    "rdl",
    "ctw",
    "email",
    "academic_discussion"
  ]);
  assert.equal(payload.pagination.total, 6);
  assert.doesNotMatch(JSON.stringify(payload), /draft|wrongbook-submitted/);
});

test("one submitted attempt stays one record, including repeated attempts for the same task", () => {
  const base = fixture();
  const secondBas = {
    attempt_id: "bas-2",
    set_id: "bas-set",
    set_title: "BAS fallback",
    correct_count: 9,
    total_questions: 10,
    time_spent_seconds: 60,
    submitted_at: "2026-08-29T06:30:00.000Z"
  };
  const payload = fixture({
    basAttempts: [secondBas, {
      attempt_id: "bas-1",
      set_id: "bas-set",
      set_title: "BAS fallback",
      correct_count: 8,
      total_questions: 10,
      time_spent_seconds: 75,
      submitted_at: "2026-08-29T06:00:00.000Z"
    }]
  });
  assert.equal(payload.records.filter((record) => record.taskType === "build_sentence").length, 2);
  assert.equal(payload.overview.allCompleted, base.overview.allCompleted + 1);
});

test("overview counts and sums all six types before list filters", () => {
  const payload = fixture({ category: "reading" });
  assert.equal(payload.overview.todayCompleted, 5);
  assert.equal(payload.overview.allCompleted, 6);
  assert.equal(payload.overview.todayDurationSeconds, 816);
  assert.equal(payload.overview.allDurationSeconds, 1308);
  assert.equal(payload.records.length, 3);
});

test("category and task type filters are server-side payload semantics", () => {
  assert.deepEqual(
    fixture({ category: "writing" }).records.map((record) => record.taskType),
    ["build_sentence", "email", "academic_discussion"]
  );
  assert.deepEqual(
    fixture({ category: "reading", taskType: "rdl" }).records.map((record) => record.attemptId),
    ["rdl-1"]
  );
});

test("writing metrics never expose accuracy or X/Y score, and published review controls action", () => {
  const payload = fixture();
  const email = payload.records.find((record) => record.attemptId === "email-1");
  const discussion = payload.records.find((record) => record.attemptId === "discussion-1");
  assert.deepEqual(email.metrics, {
    kind: "writing",
    hasPublishedReview: true,
    reviewScore: 4,
    wordCount: 186
  });
  assert.equal("accuracy" in email.metrics, false);
  assert.equal("correct" in email.metrics, false);
  assert.equal(email.resultTarget.label, "查看批改");
  assert.match(email.resultTarget.href, /^\/student\/writing-reviews\/email-1\?returnTo=/);
  assert.equal(discussion.resultTarget.label, "查看提交");
  assert.equal(discussion.resultTarget.href, "/student/academic-discussion/submission/discussion-1");
});

test("objective metrics and result/retake targets reuse the existing routes", () => {
  const payload = fixture();
  const bas = payload.records.find((record) => record.attemptId === "bas-1");
  const ctw = payload.records.find((record) => record.attemptId === "ctw-1");
  assert.deepEqual(bas.metrics, { kind: "objective", correct: 8, total: 10, accuracy: 0.8 });
  assert.equal(bas.resultTarget.href, "/student/results/bas-1?source=practice-history");
  assert.equal(bas.retakeTarget.href, "/student/practice/bas-set");
  assert.deepEqual(ctw.metrics, { kind: "objective", correct: 8, total: 10, accuracy: 0.8 });
  assert.equal(ctw.resultTarget.href, "/student/reading/results/ctw-1");
  assert.deepEqual(ctw.retakeTarget, {
    href: "/api/reading/attempts/ctw-1/retake",
    label: "重新练习",
    method: "POST"
  });
});

test("pagination applies a bounded limit after global newest-first merge", () => {
  const payload = fixture({ limit: 2, offset: 2 });
  assert.deepEqual(payload.records.map((record) => record.attemptId), ["rdl-1", "ctw-1"]);
  assert.deepEqual(payload.pagination, { limit: 2, nextOffset: 4, offset: 2, total: 6 });
});

test("unified API reads only list projections and explicitly gates submitted rows", () => {
  const source = read("app/api/unified-practice-history/route.ts");
  assert.match(source, /\.from\("attempts"\)[\s\S]*\.not\("submitted_at", "is", null\)/);
  assert.match(source, /\.from\("writing_attempts"\)[\s\S]*\.eq\("status", "submitted"\)/);
  assert.match(source, /\.from\("reading_attempts"\)[\s\S]*\.eq\("status", "submitted"\)/);
  assert.match(source, /limit/);
  assert.match(source, /offset/);
  assert.match(source, /official_score:published_scores->official_score->>teacher_score/);
  for (const forbidden of [
    "response_text",
    "student_answer",
    "published_language_edits",
    "published_content_feedback",
    "material_image",
    "sentence_template",
    "professor_prompt"
  ]) {
    assert.equal(source.includes(forbidden), false, `API must not load ${forbidden}`);
  }
});

test("legacy reading history redirects and the sidebar has only unified history", () => {
  const redirectPage = read("app/student/reading/history/page.tsx");
  const shell = read("components/student/StudentShell.tsx");
  assert.match(redirectPage, /redirect\(STUDENT_ROUTES\.practiceHistory\)/);
  assert.equal(shell.includes('label: "阅读历史"'), false);
  assert.match(shell, /path\.startsWith\("\/student\/reading\/results\/"\)/);
});

test("history UI reuses CompleteTheWordsIcon and renders writing-specific metric language", () => {
  const source = read("components/UnifiedPracticeHistory.tsx");
  assert.match(source, /CompleteTheWordsIcon/);
  assert.match(source, /评分 \$\{record\.metrics\.reviewScore/);
  assert.match(source, /: "已提交"/);
  assert.match(source, /得分 \$\{record\.metrics\.correct\}/);
});
