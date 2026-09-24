const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildLogicalPracticeCatalogSearchIndex,
  toLightweightLogicalPracticeCatalog
} = require("../lib/practiceLogicalCatalog.ts");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function sampleItem(overrides = {}) {
  return {
    item_id: "item-1",
    task_type: "email",
    display_number: "001",
    display_title: "A topic",
    catalog_category: "学术校园",
    search_text: "unique body text for searching",
    first_seen_date: "2026-01-01",
    latest_seen_date: "2026-02-01",
    occurrence_dates: ["2026-02-01", "2026-01-01"],
    occurrence_date_counts: [{ date: "2026-02-01", count: 1 }],
    occurrence_count: 2,
    canonical: {
      source_id: "source-1",
      source_set_id: null,
      source_question_id: "question-1"
    },
    question_count: 1,
    student_state: {
      status: "completed",
      resume_attempt_id: null,
      latest_attempt_id: "attempt-1",
      latest_completed_attempt_id: "attempt-1",
      can_start: false,
      can_resume: false,
      can_retake: true,
      can_view_result: true
    },
    actions: {
      start: null,
      resume: null,
      view_result: { attempt_id: "attempt-1", source_set_id: null, source_question_id: "question-1" },
      retake: { source_set_id: null, source_question_id: "question-1" }
    },
    ...overrides
  };
}

test("lightweight catalog drops search_text only and keeps every directory field", () => {
  const catalog = {
    items: [
      sampleItem(),
      sampleItem({ item_id: "item-2", display_number: "002", search_text: "second body" })
    ],
    pagination: { page: 1, page_size: 10, total_items: 2, total_pages: 1 }
  };
  const lightweight = toLightweightLogicalPracticeCatalog(catalog);

  assert.equal(lightweight.items.length, catalog.items.length);
  assert.deepEqual(lightweight.pagination, catalog.pagination);
  for (const [index, item] of lightweight.items.entries()) {
    const original = catalog.items[index];
    assert.equal("search_text" in item, false);
    for (const key of Object.keys(original)) {
      if (key === "search_text") continue;
      assert.deepEqual(item[key], original[key], `${original.item_id}.${key}`);
    }
  }
});

test("search index maps item_id to the cached catalog search_text", () => {
  const catalog = {
    items: [
      { item_id: "a", search_text: "alpha text" },
      { item_id: "b", search_text: "" }
    ]
  };
  const entries = buildLogicalPracticeCatalogSearchIndex(catalog);
  assert.deepEqual(entries, [
    { item_id: "a", search_text: "alpha text" },
    { item_id: "b", search_text: "" }
  ]);
  const ids = entries.map((entry) => entry.item_id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate item ids");
});

test("search-index route reuses the cached catalog instead of scanning raw content", () => {
  const route = read("app/api/practice-catalog/search-index/route.ts");
  assert.match(route, /loadCachedPublicPracticeCatalog\(taskType\)/);
  assert.match(route, /buildLogicalPracticeCatalogSearchIndex/);
  assert.match(route, /isLogicalPracticeTaskType/);
  assert.match(route, /requireUserWithRole\(bearerToken\(request\), "student"\)/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(route, /\.from\(/);
  assert.doesNotMatch(route, /questions|email_questions|academic_discussion_questions/);
});

test("practice-catalog API strips search_text before responding", () => {
  const route = read("app/api/practice-catalog/route.ts");
  assert.match(route, /toLightweightLogicalPracticeCatalog\(catalog\)/);
  assert.match(route, /loadCachedPublicPracticeCatalog\(taskType\)/);
});

test("writing catalog client loads the lightweight catalog first and merges the index by item_id", () => {
  const catalog = read("components/LogicalPracticeCatalog.tsx");
  const lib = read("lib/practiceLogicalCatalogSearchIndex.ts");
  assert.match(catalog, /studentLogicalCatalogSearchIndexCacheKey\(taskType\)/);
  assert.match(catalog, /enabled: Boolean\(state\.data\)/);
  assert.match(catalog, /logicalPracticeCatalogSearchTextMap\(searchIndex\)/);
  assert.match(catalog, /searchTextByItemId\.get\(item\.item_id\)/);
  assert.match(catalog, /searchIndexBlocked = searchIndexRequired && !searchIndex/);
  assert.match(catalog, /搜索数据加载中/);
  assert.match(catalog, /搜索数据加载失败/);
  assert.match(catalog, /onClick=\{onRetrySearchIndex\}/);
  assert.match(catalog, /重新加载搜索数据/);
  assert.match(lib, /\/api\/practice-catalog\/search-index\?taskType=/);
  assert.doesNotMatch(lib, /localStorage|indexedDB|sessionStorage/);
});

test("search index session cache is per task type and survives attempt state updates", () => {
  const cache = read("components/StudentDataCache.tsx");
  assert.match(cache, /logical-practice-search-index/);
  assert.match(cache, /`\$\{STUDENT_LOGICAL_CATALOG_SEARCH_INDEX_CACHE_PREFIX\}:v1:\$\{taskType\}`/);
  assert.match(
    cache,
    /studentLogicalCatalogSearchIndexCacheKey\(\s*taskType: "build_sentence" \| "email" \| "academic_discussion"\s*\)/
  );

  const attemptStateBranch = cache.match(/case "studentPracticeState":[\s\S]*?break;/)?.[0] ?? "";
  assert.doesNotMatch(attemptStateBranch, /SEARCH_INDEX/);
  const writingCatalogBranch = cache.match(/case "studentWritingCatalog":[\s\S]*?break;/)?.[0] ?? "";
  assert.doesNotMatch(writingCatalogBranch, /SEARCH_INDEX/);
  assert.match(cache, /clear = useCallback\(\(\) => \{[\s\S]*entries\.current\.clear\(\)/);
  assert.doesNotMatch(cache, /localStorage|indexedDB/);
});

test("all three logical writing roots keep using the shared async-index catalog", () => {
  for (const page of [
    "app/student/practice-sets/page.tsx",
    "app/student/write-email/page.tsx",
    "app/student/academic-discussion/page.tsx"
  ]) {
    assert.match(read(page), /<LogicalPracticeCatalog/);
  }
});
