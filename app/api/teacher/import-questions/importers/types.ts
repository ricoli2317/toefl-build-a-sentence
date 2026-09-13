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

export type ReadingDuplicateResolution = {
  pendingId: string;
  action: "reuse_existing" | "create_new";
  candidateLogicalItemId?: string;
};

export type ReadingDuplicatePreview = {
  logicalItemId: string;
  module: "ctw" | "rdl" | "rap";
  title: string | null;
  sourceLabel: string;
  occurrenceDate: string;
  sourceModule: string;
  sourceOrder: number;
  sourceQuestionRange: string;
  fields: Array<{ label: string; value: string }>;
};

export type ReadingDuplicateCandidate = ReadingDuplicatePreview & {
  firstSeenDate: string;
  firstSeenSourceLabel: string;
  sourceOccurrences: Array<{
    sourceLabel: string;
    occurrenceDate: string;
    sourceModule: string;
    sourceOrder: number;
    sourceQuestionRange: string;
  }>;
};

export type ReadingDuplicateReview = {
  pendingId: string;
  reason: string;
  addedOccurrenceCount: number;
  existingOccurrenceCount: number;
  resolvesMaterialWarning: boolean;
  incoming: ReadingDuplicatePreview;
  candidates: ReadingDuplicateCandidate[];
};

export type ImportResult = {
  success: true;
  preview?: boolean;
  csvRowCount?: number;
  acceptedRowCount?: number;
  rejectedRowCount?: number;
  occurrenceCount?: number;
  blockerCount?: number;
  successCount: number;
  insertedCount: number;
  updatedCount: number;
  logicalNewItemCount: number;
  logicalAutoMergeCount: number;
  logicalNeedsReviewCount: number;
  possibleDuplicateCount?: number;
  occurrenceInsertedCount: number;
  exactFingerprintReuseCount?: number;
  semanticReuseCount?: number;
  manualReuseCount?: number;
  existingOccurrenceCount?: number;
  occurrenceConflictCount?: number;
  rdlMaterialReuseCount?: number;
  rdlNewMaterialCount?: number;
  rdlMaterialWarningCount?: number;
  pendingDuplicates?: ReadingDuplicateReview[];
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
  fileName?: string;
  dryRun?: boolean;
  readingDuplicateResolutions?: ReadingDuplicateResolution[];
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
