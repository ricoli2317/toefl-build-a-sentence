const assert = require("node:assert/strict");
const test = require("node:test");

const { summarizeReadingImportIssues } = require("../lib/reading/importSummary.ts");

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
