const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  compareLogicalItems,
  computeReadingDisplayRanks,
  groupReadingSourceOccurrences
} = require("../lib/reading/grouping.ts");

const sourceFixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, "../data/reading/fixtures/reading-source.fixture.json"),
  "utf8"
));

function candidate(module) {
  return structuredClone(sourceFixture.occurrences.find((item) => item.module === module));
}

function atSource(item, { id, label, date, month = date.slice(0, 7), order = item.source.sourceOrder }) {
  const copy = structuredClone(item);
  copy.sourceOccurrenceId = id;
  copy.source.sourceLabel = label;
  copy.source.occurrenceDate = date;
  copy.source.yearMonth = month;
  copy.source.sourceOrder = order;
  return copy;
}

test("same CTW on two dates becomes one logical item with two occurrences", () => {
  const original = atSource(candidate("ctw"), { id: "ctw-a", label: "5.3A", date: "2026-05-03" });
  const repeated = atSource(candidate("ctw"), { id: "ctw-b", label: "5.18B", date: "2026-05-18" });
  const result = groupReadingSourceOccurrences([original, repeated]);
  assert.equal(result.packages.length, 1);
  assert.equal(result.packages[0].occurrences.length, 2);
});

test("same RDL across months keeps one logical material/question-group item", () => {
  const may = atSource(candidate("rdl"), { id: "rdl-may", label: "5.3A", date: "2026-05-03" });
  const june = atSource(candidate("rdl"), { id: "rdl-june", label: "6.12B", date: "2026-06-12" });
  const result = groupReadingSourceOccurrences([may, june]);
  assert.equal(result.packages.length, 1);
  assert.equal(result.packages[0].questions.length, 1);
  assert.deepEqual(result.packages[0].occurrences.map((item) => item.sourceLabel), ["5.3A", "6.12B"]);
});

test("same RAP occurrence reuses the passage and question identities", () => {
  const first = atSource(candidate("rap"), { id: "rap-a", label: "5.10A", date: "2026-05-10" });
  const second = atSource(candidate("rap"), { id: "rap-b", label: "6.10A", date: "2026-06-10" });
  const result = groupReadingSourceOccurrences([first, second]);
  assert.equal(result.packages.length, 1);
  assert.equal(result.packages[0].passages.length, 1);
  assert.equal(result.packages[0].questions.length, 3);
  assert.equal(new Set(result.packages[0].questions.map((item) => item.questionId)).size, 3);
});

test("a later import of an earlier occurrence moves firstSeenDate backward", () => {
  const later = atSource(candidate("ctw"), { id: "late", label: "5.18B", date: "2026-05-18" });
  const earlier = atSource(candidate("ctw"), { id: "early", label: "4.20A", date: "2026-04-20" });
  const result = groupReadingSourceOccurrences([later, earlier]);
  assert.equal(result.packages[0].item.firstSeenDate, "2026-04-20");
  assert.equal(result.packages[0].item.firstSeenSourceLabel, "4.20A");
});

test("dynamic ranks shift after inserting historical content without changing stable IDs", () => {
  const items = [
    logical("item-53", "2026-05-03", "5.3A", 1),
    logical("item-510", "2026-05-10", "5.10A", 1),
    logical("item-518", "2026-05-18", "5.18A", 1)
  ];
  const before = computeReadingDisplayRanks(items);
  const after = computeReadingDisplayRanks([...items, logical("item-515", "2026-05-15", "5.15A", 1)]);
  assert.equal(before.get("item-518").label, "套题003");
  assert.equal(after.get("item-515").label, "套题003");
  assert.equal(after.get("item-518").label, "套题004");
  assert.deepEqual(items.map((item) => item.logicalItemId), ["item-53", "item-510", "item-518"]);
});

test("same-day ordering uses source label, source order, then stable logical ID", () => {
  const items = [
    logical("item-z", "2026-05-03", "5.3B", 1),
    logical("item-b", "2026-05-03", "5.3A", 2),
    logical("item-a", "2026-05-03", "5.3A", 2),
    logical("item-first", "2026-05-03", "5.3A", 1)
  ].sort(compareLogicalItems);
  assert.deepEqual(items.map((item) => item.logicalItemId), ["item-first", "item-a", "item-b", "item-z"]);
});

function logical(id, date, label, order) {
  return {
    logicalItemId: id,
    module: "ctw",
    title: null,
    firstSeenDate: date,
    firstSeenSourceLabel: label,
    firstSeenSourceOrder: order,
    dedupFingerprint: "0".repeat(64),
    questionCount: 1,
    scoredItemCount: 10,
    isActive: false
  };
}
