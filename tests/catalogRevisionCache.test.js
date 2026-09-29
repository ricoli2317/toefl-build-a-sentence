const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("server caches are keyed by the database revision and never rebuilt blindly", () => {
  const revision = read("lib/catalogRevision.server.ts");
  const practice = read("lib/practiceCatalogCache.server.ts");
  const reading = read("lib/reading/catalogCache.server.ts");

  assert.match(revision, /from\("catalog_revisions"\)/);
  assert.match(revision, /cacheKind/);
  assert.match(revision, /isCatalogRevisionUnavailableError\(result\.error\)\) return 0;/);
  assert.match(revision, /warn\("\[catalog-revision\] read_failed"/);

  // The revision participates in each unstable_cache invocation key.
  for (const source of [practice, reading]) {
    assert.match(source, /async \(revision: number\)/);
    assert.match(source, /void revision;/);
    assert.match(source, /unstable_cache/);
    assert.match(source, /loadCatalogRevision/);
  }

  assert.match(practice, /cacheKind: "lightweight_catalog"/);
  assert.match(practice, /cacheKind: "search_index"/);
  assert.match(reading, /cacheKind: "lightweight_catalog"/);
  assert.match(reading, /cacheKind: "search_index"/);
  assert.match(reading, /taskType: "full_set"/);
});

test("BAS / WE / AD keep one lightweight loader, one search loader, and separate tags", () => {
  const practice = read("lib/practiceCatalogCache.server.ts");
  assert.match(practice, /createCatalogLoader/);
  assert.match(practice, /createSearchIndexLoader/);
  assert.match(practice, /practiceCatalogSearchIndexCacheTag/);
  assert.match(practice, /loadCachedPublicPracticeCatalog\(taskType/);
  assert.match(practice, /loadCachedPublicPracticeCatalogSearchIndex\(taskType/);
  assert.match(practice, /revalidateTag\(practiceCatalogSearchIndexCacheTag\(taskType\)\)/);
  // The lightweight loader must not build the index inline.
  const catalogLoader = practice.match(/function createCatalogLoader[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(catalogLoader.length > 0);
  assert.doesNotMatch(catalogLoader, /SearchIndex/);
});

test("Reading lightweight, search index, and Full Set catalogs use independent loaders", () => {
  const reading = read("lib/reading/catalogCache.server.ts");
  assert.match(reading, /createReadingCatalogLoader/);
  assert.match(reading, /createReadingSearchIndexLoader/);
  assert.match(reading, /createReadingFullSetCatalogLoader/);
  assert.match(reading, /loadCachedPublicReadingCatalog\(taskType/);
  assert.match(reading, /loadCachedPublicReadingCatalogSearchIndex\(taskType/);
  assert.match(reading, /loadCachedPublicReadingFullSetCatalog\(\)/);
  // The lightweight loader never selects search text or attempt rows.
  const lightweight = reading.match(/export async function loadPublicReadingCatalog[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(lightweight.length > 0);
  assert.doesNotMatch(lightweight, /catalog_search_text|reading_attempts/);
  // Occurrence dates are part of the lightweight card, not search content.
  assert.match(lightweight, /reading_source_occurrences\(occurrence_id,occurrence_date\)/);
  const searchIndex = reading.match(/export async function loadPublicReadingCatalogSearchIndex[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(searchIndex.length > 0);
  assert.match(searchIndex, /catalog_search_text/);
  assert.doesNotMatch(searchIndex, /title|question_count|scored_item_count|reading_attempts/);
});

test("reading catalog route never imports the search index cache and vice versa", () => {
  const catalogRoute = read("app/api/reading/catalog/route.ts");
  const searchRoute = read("app/api/reading/catalog/search-index/route.ts");
  assert.doesNotMatch(catalogRoute, /SearchIndex/);
  assert.doesNotMatch(searchRoute, /loadCachedPublicReadingCatalog\(/);
  assert.match(catalogRoute, /Promise\.all\(/);
  assert.match(catalogRoute, /loadStudentPracticeItemStates/);
  assert.match(catalogRoute, /attachReadingCatalogStudentStates/);
  // Legacy attempt scan only exists as the rollout fallback.
  const fallbackIndex = catalogRoute.indexOf("Transitional fallback");
  const attemptsIndex = catalogRoute.indexOf('.from("reading_attempts")');
  assert.ok(fallbackIndex > 0 && attemptsIndex > fallbackIndex);
});

test("practice-catalog route merges cached catalog with one sparse state query", () => {
  const catalog = read("lib/practiceLogicalCatalog.ts");
  assert.match(catalog, /attachLogicalPracticeStudentStateFromRows/);
  assert.match(catalog, /loadStudentPracticeItemStates/);
  const route = read("app/api/practice-catalog/route.ts");
  assert.match(route, /loadCachedPublicPracticeCatalog\(taskType\)/);
  assert.match(route, /getLogicalPracticeItems/);
});

test("the idle prefetch reuses the StudentDataCache in-flight dedupe", () => {
  const hook = read("components/shared/useIdleCatalogSearchIndex.ts");
  assert.match(hook, /useStudentCachedData<T>\(cacheKey, load, \{/);
  assert.doesNotMatch(hook, /fetch\(/);
  assert.match(hook, /requestIdleCallback/);
  assert.match(hook, /cancelIdleCallback/);
  assert.match(hook, /fallbackDelayMs = 1200/);
  assert.match(hook, /initialDelayMs = 300/);
  assert.match(hook, /idleTimeoutMs = 2000/);
  assert.match(hook, /enabled: mainCatalogReady && \(idleEnabled \|\| immediate\)/);

  const cache = read("components/StudentDataCache.tsx");
  // In-flight dedupe: a loading entry returns the existing promise.
  assert.match(cache, /if \(existing\?\.status === "loading"\) return existing\.promise as Promise<T>/);
  assert.match(cache, /if \(existing\?\.status === "refreshing"\) return existing\.promise as Promise<T>/);
});

test("full set catalog client slices locally over one cached complete payload", () => {
  const ui = read("components/reading/ReadingFullSetCatalog.tsx");
  assert.match(ui, /readingFullSetCatalogCacheKey/);
  assert.match(ui, /reading:full-sets:catalog:v2/);
  assert.match(ui, /\.slice\(\(visiblePage - 1\) \* PAGE_SIZE, visiblePage \* PAGE_SIZE\)/);
  assert.match(ui, /const PAGE_SIZE = 10/);
  assert.doesNotMatch(ui, /refreshOnMount/);
  // The invalidation prefix used by the runner/detail still matches this key.
  const cache = read("components/StudentDataCache.tsx");
  assert.match(cache, /STUDENT_READING_FULL_SET_CACHE_PREFIX = "reading:full-sets"/);
  assert.match(read("components/reading/ReadingFullSetRunner.tsx"), /invalidate\(`\$\{STUDENT_READING_FULL_SET_CACHE_PREFIX\}:catalog`\)/);
});
