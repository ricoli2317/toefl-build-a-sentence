import type { LogicalImportOutcome } from "@/lib/practiceImporter/server";
import type {
  ImportResult,
  LogicalImportMetrics,
  SupabaseLikeError
} from "./types";

export function serializeError(error: unknown) {
  const supabaseError = error as SupabaseLikeError;
  const message =
    supabaseError?.message ??
    (error instanceof Error ? error.message : "Unknown import error");
  const relationMatch = message.match(/relation \"([^\"]+)\"/i);
  const columnMatch = message.match(/column \"([^\"]+)\"/i);
  const constraintMatch = message.match(/constraint \"([^\"]+)\"/i);
  return {
    message,
    code: supabaseError?.code ?? null,
    table: supabaseError?.table ?? relationMatch?.[1] ?? null,
    column: supabaseError?.column ?? columnMatch?.[1] ?? null,
    constraint: supabaseError?.constraint ?? constraintMatch?.[1] ?? null,
    details: supabaseError?.details ?? null,
    hint: supabaseError?.hint ?? null
  };
}

export function logImportError(
  error: unknown,
  context: {
    operation: string;
    questionId?: string;
    rowNumber?: number;
    setId?: string;
  }
) {
  console.error("Teacher CSV import row failed", {
    ...context,
    ...serializeError(error)
  });
}

export function chunkRows<T>(rows: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

export function importResult(
  insertedCount: number,
  updatedCount: number,
  failedRows: ImportResult["failedRows"],
  warnings: ImportResult["warnings"] = [],
  logicalMetrics: LogicalImportMetrics = emptyLogicalImportMetrics()
): ImportResult {
  return {
    success: true,
    successCount: insertedCount + updatedCount,
    insertedCount,
    updatedCount,
    ...logicalMetrics,
    failedCount: failedRows.length,
    failedRows,
    warnings
  };
}

export function emptyLogicalImportMetrics(): LogicalImportMetrics {
  return {
    logicalNewItemCount: 0,
    logicalAutoMergeCount: 0,
    logicalNeedsReviewCount: 0,
    occurrenceInsertedCount: 0
  };
}

export function addLogicalImportOutcome(
  metrics: LogicalImportMetrics,
  outcome: LogicalImportOutcome
) {
  if (outcome.createdItem) metrics.logicalNewItemCount += 1;
  if (outcome.classification === "AUTO_MERGE" && outcome.createdSource) {
    metrics.logicalAutoMergeCount += 1;
  }
  if (outcome.classification === "NEEDS_REVIEW") {
    metrics.logicalNeedsReviewCount += 1;
  }
  metrics.occurrenceInsertedCount += outcome.occurrenceInsertedCount;
}
