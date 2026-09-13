export type ReadingImportFailureCategory =
  | "validation_error"
  | "source_conflict"
  | "actual_import_error";

export function summarizeReadingImportIssues(
  pendingResolutionCount: number,
  failures: Array<{ category?: ReadingImportFailureCategory }>
) {
  const validationErrorCount = failures.filter((failure) => failure.category === "validation_error").length;
  const sourceConflictCount = failures.filter((failure) => failure.category === "source_conflict").length;
  const actualImportErrorCount = failures.filter((failure) => failure.category === "actual_import_error").length;
  return {
    pendingResolutionCount,
    validationErrorCount,
    sourceConflictCount,
    actualImportErrorCount,
    unableToImportCount: validationErrorCount + sourceConflictCount + actualImportErrorCount
  };
}
