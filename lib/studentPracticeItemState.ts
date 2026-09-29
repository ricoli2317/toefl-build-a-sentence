import type { PracticeTaskType } from "./practiceImporter/types.ts";
import type { ReadingModule } from "./reading/types.ts";

/**
 * Sparse per-student practice item state.
 *
 * One row exists only for a (student, task_type, item) the student has actually
 * touched. A missing row is the canonical `unstarted` representation; the
 * directory merge never creates rows for untouched items.
 */
export type StudentPracticeItemTaskType = PracticeTaskType | ReadingModule | "full_set";

export type StudentPracticeItemStatus = "unstarted" | "in_progress" | "completed";

export type StudentPracticeItemLatestResult = {
  correctPoints?: number;
  totalPoints?: number;
  elapsedSeconds?: number;
};

export type StudentPracticeItemStateRow = {
  student_id: string;
  task_type: StudentPracticeItemTaskType;
  item_id: string;
  status: StudentPracticeItemStatus;
  /** Draft / active attempt used by "continue practice". */
  resume_attempt_id: string | null;
  /**
   * Raw source identity of the resume attempt when it differs from the
   * canonical source (Writing duplicate raw questions only).
   */
  resume_source_question_id: string | null;
  latest_attempt_id: string | null;
  latest_completed_attempt_id: string | null;
  attempt_count: number;
  last_started_at: string | null;
  last_completed_at: string | null;
  /** Display-only summary of the latest completed attempt (Reading). */
  latest_result: StudentPracticeItemLatestResult | null;
  updated_at: string;
};

export const STUDENT_PRACTICE_ITEM_STATE_COLUMNS = [
  "student_id",
  "task_type",
  "item_id",
  "status",
  "resume_attempt_id",
  "resume_source_question_id",
  "latest_attempt_id",
  "latest_completed_attempt_id",
  "attempt_count",
  "last_started_at",
  "last_completed_at",
  "latest_result",
  "updated_at"
].join(",");

export function studentPracticeItemStatesByItemId(rows: StudentPracticeItemStateRow[]) {
  return new Map(rows.map((row) => [row.item_id, row]));
}

export function isStudentPracticeItemStateUnavailableError(error: {
  code?: string | null;
  message?: string | null;
}) {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const message = error.message ?? "";
  return message.includes("student_practice_item_state")
    && (message.includes("does not exist") || message.includes("schema cache"));
}

export function isCatalogRevisionUnavailableError(error: {
  code?: string | null;
  message?: string | null;
}) {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const message = error.message ?? "";
  return message.includes("catalog_revisions")
    && (message.includes("does not exist") || message.includes("schema cache"));
}
