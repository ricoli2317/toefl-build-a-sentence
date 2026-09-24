const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  readingCatalogTitleParts
} = require("../lib/reading/catalog.ts");
const {
  readingCatalogDiscoverySearchText
} = require("../lib/reading/catalogDiscovery.ts");
const {
  filterAndSortCatalogItems
} = require("../lib/catalogDiscovery.ts");

const root = path.join(__dirname, "..");
const catalogUi = fs.readFileSync(path.join(root, "components/reading/ReadingCatalog.tsx"), "utf8");

const products = [
  {
    taskType: "ctw",
    displayNumber: "109",
    title: "Arts of the Japanese Rock Garden",
    searchText: "garden stones moss placement"
  },
  {
    taskType: "rdl",
    displayNumber: "161",
    title: "Hamilton Fitness Center",
    searchText: "gym membership schedule"
  },
  {
    taskType: "rap",
    displayNumber: "214",
    title: "Schiller and Verdi Operas",
    searchText: "composer theatre staging"
  }
];

const expectedTitles = {
  ctw: { prefix: "题目109", suffix: "Arts of the Japanese Rock Garden" },
  rdl: { prefix: "题目161", suffix: "Hamilton Fitness Center" },
  rap: { prefix: "题目214", suffix: "Schiller and Verdi Operas" }
};

function catalogItem(product) {
  return {
    itemId: `${product.taskType}-${product.displayNumber}`,
    taskType: product.taskType,
    displayNumber: product.displayNumber,
    title: product.title,
    firstSeenDate: "2026-05-01",
    latestSeenDate: "2026-05-01",
    occurrenceDates: ["2026-05-01"],
    occurrenceDateCounts: [{ date: "2026-05-01", count: 1 }],
    occurrenceCount: 1,
    category: "Test",
    searchText: "",
    questionCount: 3,
    scoringPointCount: 2,
    status: "unstarted",
    draftAttemptId: null,
    latestSubmittedAttempt: null
  };
}

// Mirrors the ReadingCatalog discovery stage contract: the canonical title
// passes through untouched and only searchText receives the dynamic number.
function discoveryItem(product) {
  const item = { ...catalogItem(product), searchText: product.searchText };
  return {
    ...item,
    id: item.itemId,
    searchText: readingCatalogDiscoverySearchText(item, item.searchText),
    defaultIndex: 0
  };
}

// Mirrors PracticeSetCatalogList rendering: titlePrefix + titleSuffix.
function renderCatalogTitle(set) {
  if (!set.titlePrefix) return set.setTitle;
  return set.titleSuffix ? `${set.titlePrefix} ${set.titleSuffix}` : set.titlePrefix;
}

function filters(query) {
  return {
    query,
    status: "all",
    months: [],
    categories: [],
    sortKey: "default",
    sortDirection: "desc"
  };
}

test("Reading discovery keeps CTW, RDL, and RAP canonical titles free of the dynamic number", () => {
  for (const product of products) {
    const raw = catalogItem(product);
    readingCatalogDiscoverySearchText(raw, product.searchText);
    assert.equal(raw.title, product.title);

    const item = discoveryItem(product);
    assert.equal(item.title, product.title);
    assert.doesNotMatch(item.title, /题目/);
    assert.equal(item.searchText, `题目${product.displayNumber} ${product.searchText}`);
  }
});

test("Reading catalog renders the dynamic number exactly once", () => {
  for (const product of products) {
    const item = discoveryItem(product);
    const title = readingCatalogTitleParts(item);
    assert.equal(title.prefix, expectedTitles[product.taskType].prefix);
    assert.equal(title.suffix, expectedTitles[product.taskType].suffix);

    const rendered = renderCatalogTitle({
      setId: item.id,
      setTitle: item.title,
      titlePrefix: title.prefix,
      titleSuffix: title.suffix
    });
    assert.equal(rendered, `${expectedTitles[product.taskType].prefix} ${product.title}`);
    assert.equal((rendered.match(/题目/g) ?? []).length, 1);
    assert.doesNotMatch(rendered, /(题目\d+)\s+\1/);
  }
});

test("The dynamic number remains searchable through discovery search text", () => {
  const items = products.map(discoveryItem);
  for (const product of products) {
    assert.deepEqual(
      filterAndSortCatalogItems(items, filters(`题目${product.displayNumber}`)).map((item) => item.id),
      [`${product.taskType}-${product.displayNumber}`]
    );
  }
  assert.deepEqual(
    filterAndSortCatalogItems(items, filters("题目109 Arts of the Japanese")).map((item) => item.id),
    ["ctw-109"]
  );
});

test("Canonical title and content search keep working after the fix", () => {
  for (const product of products) {
    const item = discoveryItem(product);
    assert.deepEqual(
      filterAndSortCatalogItems([item], filters(product.title)).map((entry) => entry.id),
      [item.id]
    );
    assert.deepEqual(
      filterAndSortCatalogItems([item], filters(product.searchText)).map((entry) => entry.id),
      [item.id]
    );
  }
});

test("ReadingCatalog applies one shared discovery fix for all three products", () => {
  assert.equal((catalogUi.match(/readingCatalogDiscoverySearchText\(/g) ?? []).length, 1);
  assert.match(catalogUi, /searchText: readingCatalogDiscoverySearchText\(item, searchText\)/);
  assert.match(catalogUi, /titlePrefix: title\.prefix/);
  assert.match(catalogUi, /titleSuffix: title\.suffix/);
  assert.doesNotMatch(catalogUi, /title:\s*`\$\{title\.prefix\}/);
  assert.doesNotMatch(catalogUi, /\.replace\([^)]*题目/);
});
