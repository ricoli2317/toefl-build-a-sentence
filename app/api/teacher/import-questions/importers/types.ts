import type { createServiceSupabase } from "@/lib/supabase/server";

export type ImportSupabase = ReturnType<typeof createServiceSupabase>;

export type FailedRow = {
  rowNumber: number;
  questionId: string;
  setId?: string;
  reason: string;
  code?: string | null;
  table?: string | null;
  column?: string | null;
  constraint?: string | null;
  details?: string | null;
  hint?: string | null;
  operation?: string;
};

export type ImportWarning = {
  message: string;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
  operation?: string;
};

export type ImportResult = {
  success: true;
  successCount: number;
  insertedCount: number;
  updatedCount: number;
  logicalNewItemCount: number;
  logicalAutoMergeCount: number;
  logicalNeedsReviewCount: number;
  occurrenceInsertedCount: number;
  failedCount: number;
  failedRows: FailedRow[];
  warnings: ImportWarning[];
};

export type LogicalImportMetrics = Pick<
  ImportResult,
  | "logicalNewItemCount"
  | "logicalAutoMergeCount"
  | "logicalNeedsReviewCount"
  | "occurrenceInsertedCount"
>;

export type ImporterContext = {
  rows: Array<Record<string, string>>;
  supabase: ImportSupabase;
  userId: string;
};

export type SupabaseLikeError = {
  message?: string;
  code?: string;
  table?: string;
  column?: string;
  constraint?: string;
  details?: string;
  hint?: string;
};
