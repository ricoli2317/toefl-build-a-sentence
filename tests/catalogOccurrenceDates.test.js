const assert = require("node:assert/strict");
const test = require("node:test");
const {
  countOccurrenceDates,
  formatOccurrenceDates
} = require("../lib/catalogOccurrenceDates.ts");

test("occurrence dates aggregate same-day counts newest-first", () => {
  assert.deepEqual(countOccurrenceDates([
    "2026-06-09",
    "2026-08-08",
    "2026-07-22",
    "2026-07-22",
    "2026-06-09",
    "2026-07-22"
  ]), [
    { date: "2026-08-08", count: 1 },
    { date: "2026-07-22", count: 3 },
    { date: "2026-06-09", count: 2 }
  ]);
});

test("occurrence formatter omits one and appends repeated same-day counts", () => {
  assert.equal(formatOccurrenceDates([
    { date: "2026-08-08", count: 1 },
    { date: "2026-07-22", count: 3 },
    { date: "2026-06-09", count: 2 }
  ]), "260808、260722(3)、260609(2)");
  assert.equal(formatOccurrenceDates([
    { date: "2026-08-04", count: 1 },
    { date: "2026-07-21", count: 1 }
  ]), "260804、260721");
});
