import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import {
  STUDENT_PRACTICE_ITEM_STATE_COLUMNS,
  isStudentPracticeItemStateUnavailableError,
  type StudentPracticeItemStateRow,
  type StudentPracticeItemTaskType
} from "./studentPracticeItemState.ts";
import type { StudentPerformanceTrace } from "./studentPerformance.server.ts";

export type StudentPracticeItemStateLoadResult =
  | { available: true; rows: StudentPracticeItemStateRow[] }
  | { available: false };

/**
 * Sparse indexed read: `where student_id = ? and task_type = ?` uses the
 * composite primary key (student_id, task_type, item_id). The result only
 * contains items the student actually touched.
 *
 * When the state migration has not been applied yet the loader reports
 * `available: false` so callers can fall back to the legacy attempt scan
 * during the rollout window instead of failing the catalog.
 */
export async function loadStudentPracticeItemStates(
  supabase: SupabaseClient,
  input: {
    studentId: string;
    taskType: StudentPracticeItemTaskType;
    timing?: StudentPerformanceTrace;
  }
): Promise<StudentPracticeItemStateLoadResult> {
  const read = () =>
    readAllSupabaseRows<StudentPracticeItemStateRow>((from, to) =>
      supabase
        .from("student_practice_item_state")
        .select(STUDENT_PRACTICE_ITEM_STATE_COLUMNS)
        .eq("student_id", input.studentId)
        .eq("task_type", input.taskType)
        .order("item_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: StudentPracticeItemStateRow[] | null;
        error: { code?: string | null; message: string } | null;
      }>
    );

  const result = input.timing
    ? await input.timing.measure("database", "student_practice_item_state", read)
    : await read();

  if (result.error) {
    if (isStudentPracticeItemStateUnavailableError(result.error)) {
      return { available: false };
    }
    throw new Error(
      `Failed to load student practice item state for ${input.taskType}: ${result.error.message}`
    );
  }

  return {
    available: true,
    rows: (result.data ?? []).map(normalizeStudentPracticeItemStateRow)
  };
}

function normalizeStudentPracticeItemStateRow(
  row: StudentPracticeItemStateRow
): StudentPracticeItemStateRow {
  return {
    ...row,
    attempt_count: Number(row.attempt_count ?? 0),
    status: row.status === "completed" || row.status === "in_progress"
      ? row.status
      : "unstarted"
  };
}
