const assert = require("node:assert/strict");
const test = require("node:test");
const {
  attachReadingCatalogStudentStates,
  buildReadingCatalogPublicPayload
} = require("../lib/reading/catalog.ts");
const { assertCanonicalRdlTitle } = require("../lib/reading/rdlTitles.ts");
const { READING_PRODUCT_NAMES } = require("../lib/reading/product.ts");

function item(overrides = {}) {
  return {
    logical_item_id: "rdl-brand",
    module: "rdl",
    title: "FitLife Gym Membership",
    first_seen_date: "2026-09-01",
    first_seen_source_label: "9.1A",
    first_seen_source_order: 1,
    question_count: 3,
    scored_item_count: 3,
    catalog_category: "文章网页",
    reading_source_occurrences: [
      { occurrence_id: "source-1", occurrence_date: "2026-09-01" },
      { occurrence_id: "source-2", occurrence_date: "2026-09-03" }
    ],
    ...overrides
  };
}

test("RDL catalog preserves stored brand/acronym titles instead of failing the directory", () => {
  const rows = [item(), item({
    logical_item_id: "rdl-acronym",
    title: "AI-Generated Art On Campus",
    first_seen_source_order: 2
  })];
  const before = structuredClone(rows);
  const payload = buildReadingCatalogPublicPayload({ taskType: "rdl", items: rows });
  assert.deepEqual(rows, before);
  assert.deepEqual(payload.items.map((row) => [row.itemId, row.title, row.displayNumber]), [
    ["rdl-acronym", "AI-Generated Art On Campus", "002"],
    ["rdl-brand", "FitLife Gym Membership", "001"]
  ]);
  for (const row of payload.items) {
    assert.equal(row.category, "文章网页");
    assert.deepEqual(row.occurrenceDates, ["2026-09-03", "2026-09-01"]);
    assert.equal(row.questionCount, 3);
    assert.equal(row.searchText, "");
    assert.equal("status" in row, false);
  }
  // This is a read-path fix only; source/import validation remains strict.
  assert.throws(() => assertCanonicalRdlTitle(rows[0].title), /expected Fitlife/);
  assert.throws(() => assertCanonicalRdlTitle(rows[1].title), /expected Ai-Generated/);
});

test("RDL catalog uses the shared display fallback for absent titles and nullable categories", () => {
  for (const title of [null, "", "   "]) {
    const payload = buildReadingCatalogPublicPayload({
      taskType: "rdl", items: [item({ title, catalog_category: null })]
    });
    assert.equal(payload.items[0].title, READING_PRODUCT_NAMES.rdl);
    assert.equal(payload.items[0].category, "");
  }
});

test("RDL sparse state still merges unstarted, in-progress and completed items", () => {
  const publicPayload = buildReadingCatalogPublicPayload({
    taskType: "rdl",
    items: [item(), item({ logical_item_id: "rdl-draft" }), item({ logical_item_id: "rdl-done" })]
  });
  const payload = attachReadingCatalogStudentStates(publicPayload, [
    { task_type: "rdl", item_id: "rdl-draft", status: "in_progress", resume_attempt_id: "draft-1" },
    {
      task_type: "rdl", item_id: "rdl-done", status: "completed",
      latest_completed_attempt_id: "done-1", last_completed_at: "2026-09-03T00:00:00Z",
      latest_result: { correctPoints: 2, totalPoints: 3, elapsedSeconds: 60 }
    }
  ]);
  const byId = new Map(payload.items.map((row) => [row.itemId, row]));
  assert.equal(byId.get("rdl-brand").status, "unstarted");
  assert.equal(byId.get("rdl-draft").status, "in_progress");
  assert.equal(byId.get("rdl-draft").draftAttemptId, "draft-1");
  assert.equal(byId.get("rdl-done").status, "completed");
  assert.equal(byId.get("rdl-done").latestSubmittedAttempt.attemptId, "done-1");
  assert.equal(byId.get("rdl-done").latestSubmittedAttempt.accuracy, 2 / 3);
});

test("CTW strict titles and RAP stored title behavior are unchanged", () => {
  assert.throws(() => buildReadingCatalogPublicPayload({
    taskType: "ctw", items: [item({ module: "ctw", title: null })]
  }), /CTW catalog title.*must not be empty/);
  const title = "The Complete History of a Very Ancient Ecosystem";
  assert.equal(buildReadingCatalogPublicPayload({
    taskType: "rap", items: [item({ module: "rap", title })]
  }).items[0].title, title);
});
