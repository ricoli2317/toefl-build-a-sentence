import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "../supabasePagination.ts";
import { CATEGORY_SESSION_TABLE, type CategoryHistoryRow } from "./questionCategory.ts";

export const CATEGORY_HISTORY_COLUMNS = "session_id,question_category,amount,status,completed_at,elapsed_seconds,total_points,correct_points";
/** Identity/scoring only. Shared student + teacher history never reads manifests,
 * answers or passages, and uses the same completed-at date/range boundaries.
 */
export async function loadCategoryHistoryRows(db: SupabaseClient, studentId: string, startAt: string, endAt: string) {
  const result = await readAllSupabaseRows<CategoryHistoryRow>((from, to) => db.from(CATEGORY_SESSION_TABLE)
    .select(CATEGORY_HISTORY_COLUMNS).eq("student_id", studentId).eq("status", "completed")
    .gte("completed_at", startAt).lt("completed_at", endAt)
    .order("completed_at", { ascending: false }).order("session_id", { ascending: false }).range(from, to));
  if (result.error) throw new Error(result.error.message);
  return result.data ?? [];
}
