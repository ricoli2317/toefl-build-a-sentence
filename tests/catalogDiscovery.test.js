const assert = require("node:assert/strict");
const test = require("node:test");
const {
  catalogSearchMatches,
  filterAndSortCatalogItems,
  normalizeCatalogSearchText
} = require("../lib/catalogDiscovery.ts");

function item(overrides) {
  return {
    id: "item-a",
    title: "Climate Change",
    searchText: "The natural environment affects coastal habitats.",
    status: "completed",
    occurrenceDates: ["2026-09-02", "2026-07-01", "2026-07-01"],
    occurrenceCount: 3,
    firstSeenDate: "2026-05-01",
    latestSeenDate: "2026-09-02",
    category: "生态环境",
    defaultIndex: 0,
    ...overrides
  };
}

const defaults = {
  query: "",
  status: "all",
  months: [],
  category: "",
  sortKey: "default",
  sortDirection: "desc"
};

test("search normalization ignores case and common whitespace differences", () => {
  assert.equal(normalizeCatalogSearchText("  Climate\u00a0  CHANGE "), "climate change");
  assert.equal(catalogSearchMatches("Climate change is measurable", "climate change"), true);
  assert.equal(catalogSearchMatches("Climate patterns change", "climate change"), true);
});

test("search combines continuous and light fuzzy matching without a mode switch", () => {
  assert.equal(catalogSearchMatches("protect the environment", "enviroment"), true);
  assert.equal(catalogSearchMatches("protect the environment", "---"), false);
  assert.equal(catalogSearchMatches("protect the environment", "astronomy"), false);
});

test("months are OR while search, status, and category combine with AND", () => {
  const items = [
    item({ id: "match" }),
    item({ id: "wrong-category", category: "科技" }),
    item({ id: "wrong-status", status: "unstarted" }),
    item({ id: "wrong-month", occurrenceDates: ["2026-06-01"] })
  ];
  const result = filterAndSortCatalogItems(items, {
    ...defaults,
    query: "environment",
    status: "completed",
    months: ["2026-07", "2026-09"],
    category: "生态环境"
  });
  assert.deepEqual(result.map(({ id }) => id), ["match"]);
});

test("default order is preserved and non-default sorts use stable item-id ties", () => {
  const items = [
    item({ id: "b", defaultIndex: 0, occurrenceCount: 2 }),
    item({ id: "a", defaultIndex: 1, occurrenceCount: 2 }),
    item({ id: "c", defaultIndex: 2, occurrenceCount: 4 })
  ];
  assert.deepEqual(filterAndSortCatalogItems(items, defaults).map(({ id }) => id), ["b", "a", "c"]);
  assert.deepEqual(filterAndSortCatalogItems(items, {
    ...defaults,
    sortKey: "occurrence_count",
    sortDirection: "desc"
  }).map(({ id }) => id), ["c", "a", "b"]);
});
