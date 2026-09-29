const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildLogicalPracticeCatalog
} = require("../lib/practiceLogicalCatalog.ts");
const {
  createPracticePublicUniverse
} = require("../lib/practicePublicUniverse.ts");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function fixture() {
  const snapshot = {
    items: [
      {
        item_id: "email-item-1",
        task_type: "email",
        display_number: "001",
        display_title: "A topic",
        first_seen_date: "2026-01-01",
        is_active: true
      }
    ],
    sources: [
      {
        source_id: "source-1",
        item_id: "email-item-1",
        task_type: "email",
        source_set_id: null,
        source_question_id: "question-1",
        is_canonical: true
      }
    ],
    questionMaps: [],
    buildSentenceQuestions: [],
    emailQuestions: [{ question_id: "question-1" }],
    academicDiscussionQuestions: []
  };
  const occurrences = [{ source_id: "source-1", occurred_on: "2026-01-01" }];
  return { snapshot, occurrences };
}

test("lightweight catalog builds directory fields without any search text", () => {
  const { snapshot, occurrences } = fixture();
  const catalog = buildLogicalPracticeCatalog({
    universe: createPracticePublicUniverse(snapshot),
    occurrences,
    taskType: "email",
    page: 1
  });

  assert.equal(catalog.items.length, 1);
  const item = catalog.items[0];
  assert.equal("search_text" in item, false);
  for (const key of [
    "item_id",
    "task_type",
    "display_number",
    "display_title",
    "catalog_category",
    "first_seen_date",
    "latest_seen_date",
    "occurrence_dates",
    "occurrence_date_counts",
    "occurrence_count",
    "canonical",
    "question_count"
  ]) {
    assert.ok(key in item, `${key} must stay in the lightweight catalog`);
  }
});

test("the student lightweight catalog loader never opts into search text", () => {
  const catalog = read("lib/practiceLogicalCatalog.ts");
  assert.match(catalog, /includeSearchText\?: boolean/);
  assert.match(catalog, /includeSearchText \? \{ search_text: item\.catalogSearchText \} : \{\}/);
  const loader = catalog.match(/export async function loadPublicLogicalPracticeCatalog[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(loader.length > 0);
  assert.doesNotMatch(loader, /includeSearchText/);
  assert.doesNotMatch(loader, /loadPracticeCatalogSearchMetadata/);
});

test("the search index has its own loader that is never imported by the catalog builder", () => {
  const indexLoader = read("lib/practiceCatalogSearchIndex.server.ts");
  const catalog = read("lib/practiceLogicalCatalog.ts");
  assert.match(indexLoader, /loadPracticeCatalogSearchMetadata/);
  assert.match(indexLoader, /item_id: item\.itemId/);
  assert.match(indexLoader, /search_text: item\.catalogSearchText/);
  assert.doesNotMatch(catalog, /practiceCatalogSearchIndex/);
});

test("search-index route reuses the dedicated search index cache", () => {
  const route = read("app/api/practice-catalog/search-index/route.ts");
  const cache = read("lib/practiceCatalogCache.server.ts");
  assert.match(route, /loadCachedPublicPracticeCatalogSearchIndex\(taskType\)/);
  assert.match(route, /isLogicalPracticeTaskType/);
  assert.match(route, /requireUserWithRole\(bearerToken\(request\), "student"\)/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.doesNotMatch(route, /\.from\(/);
  assert.doesNotMatch(route, /loadCachedPublicPracticeCatalog\(taskType\)/);
  assert.match(cache, /searchIndexLoaders/);
  assert.match(cache, /loadPublicLogicalPracticeCatalogSearchIndex/);
});

test("practice-catalog API returns the merged catalog without stripping content", () => {
  const route = read("app/api/practice-catalog/route.ts");
  assert.match(route, /getLogicalPracticeItems/);
  assert.match(route, /loadCachedPublicPracticeCatalog\(taskType\)/);
  assert.doesNotMatch(route, /toLightweightLogicalPracticeCatalog/);
  assert.doesNotMatch(route, /search_text/);
});

test("catalog client prefetches the search index only after the first screen", () => {
  const catalog = read("components/LogicalPracticeCatalog.tsx");
  const hook = read("components/shared/useIdleCatalogSearchIndex.ts");
  const lib = read("lib/practiceLogicalCatalogSearchIndex.ts");
  assert.match(catalog, /useIdleCatalogSearchIndex/);
  assert.match(catalog, /cacheKey: searchIndexKey/);
  assert.match(catalog, /mainCatalogReady: Boolean\(state\.data\)/);
  assert.match(catalog, /immediate: normalizeCatalogSearchText\(controls\.query\)\.length > 0/);
  assert.match(catalog, /logicalPracticeCatalogSearchTextMap\(searchIndex\)/);
  assert.match(catalog, /searchTextByItemId\.get\(item\.item_id\)/);
  assert.match(catalog, /searchIndexBlocked = searchIndexRequired && !searchIndex/);
  assert.match(catalog, /搜索数据加载中/);
  assert.match(catalog, /搜索数据加载失败/);
  assert.match(catalog, /onClick=\{onRetrySearchIndex\}/);
  assert.match(catalog, /重新加载搜索数据/);
  assert.match(hook, /requestIdleCallback/);
  assert.match(hook, /timeout: idleTimeoutMs/);
  assert.match(hook, /window\.setTimeout\(enable, fallbackDelayMs\)/);
  assert.match(hook, /enabled: mainCatalogReady && \(idleEnabled \|\| immediate\)/);
  assert.match(hook, /useStudentCachedData/);
  assert.doesNotMatch(hook, /fetch\(/);
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
