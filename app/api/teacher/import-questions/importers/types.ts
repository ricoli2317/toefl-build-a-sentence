import type { createServiceSupabase } from "@/lib/supabase/server";
import type {
  ReadingDuplicateResolutionInput,
  ReadingDuplicateResolutionItem
} from "@/lib/reading/duplicateResolutionModel";
import type { ReadingImportFailureCategory } from "@/lib/reading/importSummary";
import type {
  ReadingContentConflictItem,
  ReadingContentConflictResolution
} from "@/lib/reading/contentReconciliation";
import type { RdlImportGroupDecision } from "@/lib/reading/rdlImportDecision";

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
  category?: ReadingImportFailureCategory;
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
  preview?: boolean;
  csvRowCount?: number;
  acceptedRowCount?: number;
  rejectedRowCount?: number;
  occurrenceCount?: number;
  blockerCount?: number;
  unableToImportCount?: number;
  validationErrorCount?: number;
  sourceConflictCount?: number;
  actualImportErrorCount?: number;
  successCount: number;
  insertedCount: number;
  updatedCount: number;
  logicalNewItemCount: number;
  logicalReusedItemCount?: number;
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
  hasPendingDuplicates?: boolean;
  pendingResolutionItems?: ReadingDuplicateResolutionItem[];
  contentConflictCount?: number;
  contentConflictItems?: ReadingContentConflictItem[];
  rdlGroupDecisions?: RdlImportGroupDecision[];
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
  readingDuplicateResolutions?: ReadingDuplicateResolutionInput[];
  readingContentConflictResolutions?: ReadingContentConflictResolution[];
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
