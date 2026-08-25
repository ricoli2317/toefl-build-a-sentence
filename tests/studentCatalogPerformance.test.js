const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildStudentDashboardSummary,
  latestDashboardDraft
} = require("../lib/studentDashboardSummary.ts");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function writingAttempt(overrides) {
  return {
    attempt_id: "writing-1",
    assignment_id: null,
    task_type: "email",
    question_id: "email-question-1",
    word_count: 0,
    status: "draft",
    saved_at: null,
    submitted_at: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides
  };
}

test("dashboard summary keeps only the lightweight counts and latest free-practice drafts", () => {
  const writingAttempts = [
    writingAttempt({ attempt_id: "old-draft", word_count: 10 }),
    writingAttempt({
      attempt_id: "new-draft",
      question_id: "email-question-2",
      word_count: 42,
      updated_at: "2026-08-20T00:00:00.000Z"
    }),
    writingAttempt({
      attempt_id: "assignment-draft",
      assignment_id: "assignment-1",
      updated_at: "2026-08-24T00:00:00.000Z"
    }),
    writingAttempt({
      attempt_id: "submitted-august",
      status: "submitted",
      submitted_at: "2026-08-03T00:00:00.000Z"
    }),
    writingAttempt({
      attempt_id: "submitted-july",
      status: "submitted",
      submitted_at: "2026-07-01T00:00:00.000Z"
    })
  ];
  assert.equal(latestDashboardDraft(writingAttempts, "email").attempt_id, "new-draft");

  const summary = buildStudentDashboardSummary({
    buildSentenceAttempts: [
      {
        attempt_id: "bas-attempt-1",
        set_id: "20260801-A",
        submitted_at: "2026-08-02T08:00:00.000Z",
        created_at: "2026-08-02T07:00:00.000Z"
      },
      {
        attempt_id: "bas-attempt-2",
        set_id: "20260701-A",
        submitted_at: "2026-08-02T09:00:00.000Z",
        created_at: "2026-08-02T08:00:00.000Z"
      },
      {
        attempt_id: "virtual-attempt",
        set_id: "grammar-all-conditionals",
        submitted_at: "2026-08-04T00:00:00.000Z",
        created_at: "2026-08-04T00:00:00.000Z"
      }
    ],
    buildSentenceCatalog: {
      catalog: {
        items: [{ item_id: "item-a" }, { item_id: "item-b" }],
        pagination: { page: 1, page_size: 10, total_items: 2, total_pages: 1 }
      },
      sources: [
        { sourceId: "source-a1", itemId: "item-a", taskType: "build_sentence", sourceSetId: "20260801-A", sourceQuestionId: null, isCanonical: true },
        { sourceId: "source-a2", itemId: "item-a", taskType: "build_sentence", sourceSetId: "20260701-A", sourceQuestionId: null, isCanonical: false },
        { sourceId: "source-b", itemId: "item-b", taskType: "build_sentence", sourceSetId: "20260802-B", sourceQuestionId: null, isCanonical: true },
        { sourceId: "source-virtual", itemId: "item-b", taskType: "build_sentence", sourceSetId: "grammar-all-conditionals", sourceQuestionId: null, isCanonical: false }
      ]
    },
    draftDisplayNames: { email: "最新邮件题" },
    now: new Date("2026-08-25T12:00:00.000Z"),
    pendingFeedbackCount: 3,
    writingAttempts
  });

  assert.deepEqual(summary.buildSentence, {
    completedSetCount: 1,
    currentMonthSetCount: 2,
    totalSetCount: 2
  });
  assert.deepEqual(summary.drafts.email, { displayName: "最新邮件题", wordCount: 42 });
  assert.equal(summary.drafts.academic_discussion, null);
  assert.deepEqual(summary.overview, {
    currentMonthPracticeCount: 3,
    learningDayCount: 3,
    pendingFeedbackCount: 3,
    totalPracticeCount: 4
  });
});

test("public catalog data is cached and invalidated after both import mutation paths", () => {
  const cache = read("lib/practiceCatalogCache.server.ts");
  const catalogRoute = read("app/api/practice-catalog/route.ts");
  const importRoute = read("app/api/teacher/import-questions/route.ts");
  const reviewRoute = read("app/api/teacher/import-reviews/route.ts");
  assert.match(cache, /unstable_cache/);
  assert.match(cache, /revalidate: 60 \* 60/);
  assert.match(cache, /revalidateTag\(practiceCatalogCacheTag\(taskType\)\)/);
  assert.match(catalogRoute, /loadCachedPublicPracticeCatalog\(taskType\)/);
  assert.match(importRoute, /successCount > 0[\s\S]*revalidatePracticeCatalog/);
  assert.match(reviewRoute, /resolve_practice_import_review_v2[\s\S]*revalidatePracticeCatalog/);
});

test("catalog public data and student state load in parallel with fewer database stages", () => {
  const catalog = read("lib/practiceLogicalCatalog.ts");
  const universe = read("lib/practicePublicUniverse.ts");
  assert.match(catalog, /Promise\.all\(\[[\s\S]*publicCatalogPromise[\s\S]*loadLogicalPracticeStudentAttempts/);
  assert.match(universe, /Promise\.all\(\[[\s\S]*practice_items[\s\S]*practice_item_sources/);
  assert.match(universe, /\.eq\("task_type", taskType\)/);
});

test("student home uses one summary request instead of the five legacy detail requests", () => {
  const dashboard = read("components/student/StudentDashboard.tsx");
  const route = read("app/api/student/dashboard-summary/route.ts");
  assert.match(dashboard, /GET \/api\/student\/dashboard-summary/);
  for (const legacy of [
    "usePracticeHistory",
    "useWritingCatalog",
    "useWritingOverview",
    'fetch("/api/sets"'
  ]) assert.equal(dashboard.includes(legacy), false);
  assert.match(route, /Promise\.all\(\[/);
  assert.match(route, /attempt_id,assignment_id,task_type,question_id,word_count,status/);
  assert.doesNotMatch(route, /prompt|sentence_template|correct_order_text|options_text/);
});

test("performance trace begins on navigation and ends after content becomes visible", () => {
  const performance = read("lib/studentPerformance.client.ts");
  const dashboard = read("components/student/StudentDashboard.tsx");
  const shell = read("components/student/StudentShell.tsx");
  assert.match(performance, /event: "navigation_started"/);
  assert.match(performance, /requestAnimationFrame/);
  assert.match(performance, /event: "page_main_content_visible"/);
  assert.match(performance, /activePageTrace && !activePageTrace\.completed/);
  assert.match(dashboard, /beginStudentNavigationTrace\(href\)/);
  assert.match(shell, /beginStudentNavigationTrace\(item\.href!\)/);
});

test("performance migration defines the composite indexes used by catalog and dashboard reads", () => {
  const sql = read("supabase/student_catalog_performance_indexes.sql");
  for (const indexName of [
    "practice_items_active_catalog_idx",
    "practice_item_sources_catalog_idx",
    "practice_item_occurrences_catalog_idx",
    "attempts_student_set_latest_idx",
    "writing_attempts_student_dashboard_idx",
    "writing_reviews_published_attempt_idx"
  ]) assert.match(sql, new RegExp(indexName));
});
