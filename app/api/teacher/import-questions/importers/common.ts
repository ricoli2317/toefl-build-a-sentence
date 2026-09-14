import type { LogicalImportOutcome } from "@/lib/practiceImporter/server";
import type {
  ImportResult,
  LogicalImportMetrics
} from "./types";

export function serializeError(error: unknown) {
  const chain = errorChain(error);
  const message = firstString(chain, "message")
    ?? (error instanceof Error ? error.message : "Unknown import error");
  const relationMatch = message.match(/relation \"([^\"]+)\"/i);
  const columnMatch = message.match(/column \"([^\"]+)\"/i);
  const constraintMatch = message.match(/constraint \"([^\"]+)\"/i);
  return {
    message,
    code: firstString(chain, "code") ?? fallbackImportErrorCode(chain),
    table: firstString(chain, "table") ?? relationMatch?.[1] ?? null,
    column: firstString(chain, "column") ?? columnMatch?.[1] ?? null,
    constraint: firstString(chain, "constraint") ?? constraintMatch?.[1] ?? null,
    details: firstString(chain, "details") ?? structuredErrorDetails(chain),
    hint: firstString(chain, "hint") ?? null
  };
}

function errorChain(error: unknown) {
  const result: Array<Record<string, unknown>> = [];
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    result.push(record);
    for (const key of ["cause", "error", "originalError"]) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }
  return result;
}

function firstString(chain: Array<Record<string, unknown>>, key: string) {
  for (const candidate of chain) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function fallbackImportErrorCode(chain: Array<Record<string, unknown>>) {
  const name = firstString(chain, "name");
  if (name === "ReadingValidationError") return "READING_VALIDATION_ERROR";
  return "IMPORT_FAILED";
}

function structuredErrorDetails(chain: Array<Record<string, unknown>>) {
  const validationError = chain.find((candidate) => candidate.name === "ReadingValidationError");
  if (!validationError) return null;
  return [
    typeof validationError.logicalItemId === "string"
      ? `logical_item_id=${validationError.logicalItemId}`
      : null,
    typeof validationError.questionId === "string"
      ? `question_id=${validationError.questionId}`
      : null,
    typeof validationError.path === "string" ? `path=${validationError.path}` : null
  ].filter(Boolean).join("; ") || null;
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
