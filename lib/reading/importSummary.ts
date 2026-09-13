export type ReadingImportFailureCategory =
  | "validation_error"
  | "source_conflict"
  | "actual_import_error";

export type ReadingUnableToImportDetail = {
  rowNumber: number;
  questionId: string;
  setId?: string;
  reason: string;
  code?: string | null;
  category?: ReadingImportFailureCategory;
};

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

export function assertReadingUnableToImportDetailInvariant(input: {
  unableToImportCount: number;
  failedRows: ReadingUnableToImportDetail[];
}) {
  if (input.unableToImportCount !== input.failedRows.length) {
    throw unableDetailInvariantError(
      `summary=${input.unableToImportCount}; details=${input.failedRows.length}`
    );
  }
  for (const detail of input.failedRows) {
    const hasRow = Number.isInteger(detail.rowNumber) && detail.rowNumber > 0;
    const hasGroupField = typeof detail.questionId === "string";
    const hasSourceField = Object.prototype.hasOwnProperty.call(detail, "setId");
    const hasCategory = detail.category === "validation_error"
      || detail.category === "source_conflict"
      || detail.category === "actual_import_error";
    const hasCode = typeof detail.code === "string" && detail.code.trim().length > 0;
    const hasReason = typeof detail.reason === "string" && detail.reason.trim().length > 0;
    if (!hasRow || !hasGroupField || !hasSourceField || !hasCategory || !hasCode || !hasReason) {
      throw unableDetailInvariantError(
        `invalid detail at CSV row ${String(detail.rowNumber)}`
      );
    }
  }
}

function unableDetailInvariantError(details: string) {
  return Object.assign(
    new Error(`Reading unable-to-import detail invariant failed: ${details}`),
    { code: "READING_UNABLE_TO_IMPORT_DETAIL_INVARIANT" }
  );
}
