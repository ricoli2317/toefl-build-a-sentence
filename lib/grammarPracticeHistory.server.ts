import type { SupabaseClient } from "@supabase/supabase-js";
import type { TeacherBasCategorySessionRow } from "./teacherStudentPractice.ts";
import { readAllSupabaseRows } from "./supabasePagination.ts";

export const BAS_CATEGORY_HISTORY_COLUMNS =
  "session_id,assignment_id,category,categories,status,completed_at,started_at,elapsed_seconds,total_questions,correct_count,attempt_id";

/**
 * Completed teacher-assigned BAS Grammar category sessions for one student and
 * one completed-at window. Identity / scoring / timing only: the frozen
 * Manifest, answers and draft never leave the session owner's practice flow.
 *
 * Self-practice BAS sessions (assignment_id is null) are intentionally not
 * loaded here: they keep their existing virtual-set treatment in history.
 */
export async function loadBasCategoryHistoryRows(
  db: SupabaseClient,
  studentId: string,
  startAt: string,
  endAt: string
): Promise<TeacherBasCategorySessionRow[]> {
  const result = await readAllSupabaseRows<TeacherBasCategorySessionRow>((from, to) =>
    db
      .from("bas_grammar_practice_sessions")
      .select(BAS_CATEGORY_HISTORY_COLUMNS)
      .eq("student_id", studentId)
      .eq("status", "completed")
      .not("assignment_id", "is", null)
      .gte("completed_at", startAt)
      .lt("completed_at", endAt)
      .order("completed_at", { ascending: false })
      .order("session_id", { ascending: false })
      .range(from, to)
  );
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}
