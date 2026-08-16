import type { ImportResult, SupabaseLikeError } from "./types";

export function serializeError(error: unknown) {
  const supabaseError = error as SupabaseLikeError;
  return {
    message:
      supabaseError?.message ??
      (error instanceof Error ? error.message : "Unknown import error"),
    code: supabaseError?.code ?? null,
    details: supabaseError?.details ?? null,
    hint: supabaseError?.hint ?? null
  };
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
  warnings: ImportResult["warnings"] = []
): ImportResult {
  return {
    success: true,
    successCount: insertedCount + updatedCount,
    insertedCount,
    updatedCount,
    failedCount: failedRows.length,
    failedRows,
    warnings
  };
}
