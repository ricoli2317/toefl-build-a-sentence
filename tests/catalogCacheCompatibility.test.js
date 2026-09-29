const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("student catalog cache keys and server cache are versioned after schema changes", () => {
  const clientCache = read("components/StudentDataCache.tsx");
  const serverCache = read("lib/practiceCatalogCache.server.ts");
  assert.match(clientCache, /logical-practice-catalog.*:v3:/s);
  assert.match(clientCache, /reading:catalog.*:v2:/s);
  assert.match(serverCache, /PRACTICE_CATALOG_CACHE_VERSION = 4/);
  assert.match(serverCache, /loadCatalogRevision/);
  assert.match(serverCache, /cacheKind: "lightweight_catalog"/);
  assert.match(serverCache, /cacheKind: "search_index"/);
});

test("student catalog renderers tolerate old occurrence and discovery field names", () => {
  const logical = read("components/LogicalPracticeCatalog.tsx");
  const reading = read("components/reading/ReadingCatalog.tsx");
  const formatter = read("lib/catalogOccurrenceDates.ts");
  assert.match(logical, /occurrenceDateCounts/);
  assert.match(logical, /searchText\?: string/);
  assert.match(logical, /category\?: string \| null/);
  assert.match(reading, /occurrence_date_counts/);
  assert.match(reading, /search_text\?: string/);
  assert.match(reading, /catalog_category\?: string/);
  assert.match(formatter, /\(dates \?\? \[\]\)\.map/);
});
