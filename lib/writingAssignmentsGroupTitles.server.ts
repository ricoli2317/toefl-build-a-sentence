import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "./supabasePagination.ts";

type GroupTitleRow = { group_id: string; title: string | null };
type RecipientOrderRow = {
  assignment_id: string;
  student_id: string;
  sort_order: number | null;
};

/**
 * PostgREST reports a missing column before the additive migration has been
 * applied. Titles and recipient order are overlays on the legacy display and
 * ordering chains, so that specific error degrades to "not persisted yet"
 * instead of breaking the whole list.
 */
function isMissingColumnError(
  error: { code?: string; message?: string } | null,
  column: string
) {
  if (!error) return false;
  return error.code === "42703"
    || new RegExp(`\\b${column}\\b.*does not exist`, "i").test(error.message ?? "");
}

/**
 * Loads the persisted Assignment Group titles once per request. Groups created
 * before the title column existed simply stay absent and callers keep using the
 * resolved question display name as the historical fallback.
 */
export async function loadWritingAssignmentGroupTitles(
  supabase: SupabaseClient,
  groupIds: ReadonlyArray<string | null | undefined>
): Promise<Map<string, string>> {
  const ids = Array.from(
    new Set(groupIds.filter((value): value is string => Boolean(value?.trim())))
  );
  const titles = new Map<string, string>();
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100);
    const result = await readAllSupabaseRows<GroupTitleRow>((from, to) =>
      supabase
        .from("writing_assignment_groups")
        .select("group_id,title")
        .in("group_id", batch)
        .order("group_id", { ascending: true })
        .range(from, to)
    );
    if (result.error) {
      if (isMissingColumnError(result.error, "title")) {
        console.warn(
          "[writing-assignments] group_title_column_missing",
          "Run supabase/writing_assignment_group_titles.sql to persist Assignment Group titles."
        );
        return titles;
      }
      throw result.error;
    }
    for (const row of result.data ?? []) {
      const title = row.title?.trim();
      if (title) titles.set(String(row.group_id), title);
    }
  }
  return titles;
}

/**
 * Loads the creation-time recipient order (teacher selection order) keyed by
 * `assignment_id:student_id`. Pre-migration rows stay absent and callers keep
 * the legacy assigned_at/student_id ordering.
 */
export async function loadWritingAssignmentRecipientOrders(
  supabase: SupabaseClient,
  assignmentIds: ReadonlyArray<string>
): Promise<Map<string, number>> {
  const ids = Array.from(
    new Set(assignmentIds.filter((value) => Boolean(value?.trim())))
  );
  const orders = new Map<string, number>();
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100);
    const result = await readAllSupabaseRows<RecipientOrderRow>((from, to) =>
      supabase
        .from("writing_assignment_students")
        .select("assignment_id,student_id,sort_order")
        .in("assignment_id", batch)
        .order("assignment_id", { ascending: true })
        .order("student_id", { ascending: true })
        .range(from, to)
    );
    if (result.error) {
      if (isMissingColumnError(result.error, "sort_order")) {
        console.warn(
          "[writing-assignments] recipient_order_column_missing",
          "Run supabase/writing_assignment_group_titles.sql to persist recipient order."
        );
        return orders;
      }
      throw result.error;
    }
    for (const row of result.data ?? []) {
      if (typeof row.sort_order === "number" && row.sort_order > 0) {
        orders.set(`${row.assignment_id}:${row.student_id}`, row.sort_order);
      }
    }
  }
  return orders;
}
