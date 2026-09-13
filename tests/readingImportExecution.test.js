const assert = require("node:assert/strict");
const test = require("node:test");

const { summarizeReadingImportExecutions } = require("../lib/reading/importExecution.ts");

const created = (insertedOccurrenceCount = 1, existingOccurrenceCount = 0) => ({
  logicalItemAction: "create_new",
  logicalReuseKind: null,
  insertedOccurrenceCount,
  existingOccurrenceCount
});

const reused = (
  logicalReuseKind = "exact_fingerprint",
  insertedOccurrenceCount = 1,
  existingOccurrenceCount = 0
) => ({
  logicalItemAction: "reuse_existing",
  logicalReuseKind,
  insertedOccurrenceCount,
  existingOccurrenceCount
});

function publicMetrics(executions) {
  const result = summarizeReadingImportExecutions(executions);
  return {
    reused: result.logicalReusedItemCount,
    created: result.logicalNewItemCount,
    insertedOccurrences: result.occurrenceInsertedCount,
    existingOccurrences: result.existingOccurrenceCount
  };
}

test("one existing and two new groups keep their execution result after all three exist", () => {
  const finalResult = publicMetrics([reused("semantic"), created(), created()]);
  assert.deepEqual(finalResult, {
    reused: 1,
    created: 2,
    insertedOccurrences: 3,
    existingOccurrences: 0
  });

  // A later database lookup would classify all three as existing. It must not
  // replace the result captured by the import executions above.
  const postWriteClassification = publicMetrics([reused(), reused(), reused()]);
  assert.deepEqual(postWriteClassification, {
    reused: 3,
    created: 0,
    insertedOccurrences: 3,
    existingOccurrences: 0
  });
  assert.deepEqual(finalResult, {
    reused: 1,
    created: 2,
    insertedOccurrences: 3,
    existingOccurrences: 0
  });
});

test("three existing groups report three reused and no new logical items", () => {
  assert.deepEqual(publicMetrics([reused(), reused("semantic"), reused()]), {
    reused: 3,
    created: 0,
    insertedOccurrences: 3,
    existingOccurrences: 0
  });
});

test("three new groups report three newly created logical items", () => {
  assert.deepEqual(publicMetrics([created(), created(), created()]), {
    reused: 0,
    created: 3,
    insertedOccurrences: 3,
    existingOccurrences: 0
  });
});

test("a same-batch duplicate occurrence is not counted as reusing an existing logical item", () => {
  assert.deepEqual(publicMetrics([reused(), created(2)]), {
    reused: 1,
    created: 1,
    insertedOccurrences: 3,
    existingOccurrences: 0
  });
});

test("reimport reports the second execution as idempotent", () => {
  const first = publicMetrics([reused(), created(), created()]);
  const second = publicMetrics([reused("semantic", 0, 1), reused("exact_fingerprint", 0, 1), reused("exact_fingerprint", 0, 1)]);
  assert.deepEqual(first, {
    reused: 1,
    created: 2,
    insertedOccurrences: 3,
    existingOccurrences: 0
  });
  assert.deepEqual(second, {
    reused: 3,
    created: 0,
    insertedOccurrences: 0,
    existingOccurrences: 3
  });
});
