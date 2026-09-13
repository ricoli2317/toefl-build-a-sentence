const test = require("node:test");
const assert = require("node:assert/strict");

test("bounded mapper preserves order and caps simultaneous Supabase batches", async () => {
  const { mapWithConcurrency } = await import("../lib/mapWithConcurrency.ts");
  let active = 0;
  let maximum = 0;
  const values = Array.from({ length: 12 }, (_, index) => index);
  const results = await mapWithConcurrency(values, 3, async (value) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, value % 2));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(results, values.map((value) => value * 2));
  assert.equal(maximum, 3);
});
