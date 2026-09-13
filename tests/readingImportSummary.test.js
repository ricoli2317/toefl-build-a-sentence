const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertReadingUnableToImportDetailInvariant,
  summarizeReadingImportIssues
} = require("../lib/reading/importSummary.ts");

function failure(category, overrides = {}) {
  return {
    rowNumber: 2,
    questionId: "7.6A-m1-1",
    setId: "7.6A",
    reason: "deterministic test failure",
    code: category === "source_conflict" ? "READING_SOURCE_CONFLICT" : "READING_VALIDATION_ERROR",
    category,
    ...overrides
  };
}

test("pending duplicate resolutions never count as unable to import", () => {
  assert.deepEqual(summarizeReadingImportIssues(3, []), {
    pendingResolutionCount: 3,
    validationErrorCount: 0,
    sourceConflictCount: 0,
    actualImportErrorCount: 0,
    unableToImportCount: 0
  });
});

test("only validation, source conflict, and execution failures count as unable to import", () => {
  assert.deepEqual(summarizeReadingImportIssues(2, [
    { category: "validation_error" },
    { category: "source_conflict" },
    { category: "actual_import_error" }
  ]), {
    pendingResolutionCount: 2,
    validationErrorCount: 1,
    sourceConflictCount: 1,
    actualImportErrorCount: 1,
    unableToImportCount: 3
  });
});

test("one validation failure reports unable one", () => {
  const failures = [failure("validation_error")];
  const summary = summarizeReadingImportIssues(0, failures);
  assert.equal(summary.pendingResolutionCount, 0);
  assert.equal(summary.unableToImportCount, 1);
  assert.doesNotThrow(() => assertReadingUnableToImportDetailInvariant({
    unableToImportCount: summary.unableToImportCount,
    failedRows: failures
  }));
});

test("one occurrence or source conflict reports unable one", () => {
  const failures = [failure("source_conflict")];
  const summary = summarizeReadingImportIssues(0, failures);
  assert.equal(summary.sourceConflictCount, 1);
  assert.equal(summary.unableToImportCount, 1);
  assert.doesNotThrow(() => assertReadingUnableToImportDetailInvariant({
    unableToImportCount: summary.unableToImportCount,
    failedRows: failures
  }));
});

test("pending plus validation keeps needs-review and unable independent", () => {
  const failures = [failure("validation_error")];
  const summary = summarizeReadingImportIssues(1, failures);
  assert.equal(summary.pendingResolutionCount, 1);
  assert.equal(summary.unableToImportCount, 1);
});

test("unable-to-import count requires one complete visible detail per failure", () => {
  assert.throws(
    () => assertReadingUnableToImportDetailInvariant({ unableToImportCount: 1, failedRows: [] }),
    (error) => error.code === "READING_UNABLE_TO_IMPORT_DETAIL_INVARIANT"
  );
  assert.throws(
    () => assertReadingUnableToImportDetailInvariant({
      unableToImportCount: 1,
      failedRows: [failure("validation_error", { code: null })]
    }),
    (error) => error.code === "READING_UNABLE_TO_IMPORT_DETAIL_INVARIANT"
  );
});
