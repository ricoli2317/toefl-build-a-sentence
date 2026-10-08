import type { SupabaseClient } from "@supabase/supabase-js";
import { parseWordbookQuery, type WordbookList } from "./wordbookList.ts";

export async function readWordbookList(db: SupabaseClient, studentId: string, query: ReturnType<typeof parseWordbookQuery>): Promise<WordbookList> {
  const { data, error } = await db.rpc("read_student_wordbook_v1", {
    p_student_id: studentId, p_domain: query.domain, p_page: query.page, p_page_size: query.pageSize,
    p_sort: query.sort, p_start_at: query.startAt, p_end_at: query.endAt
  });
  if (error || !data || !Array.isArray(data.items) || typeof data.total !== "number") throw new Error("WORDBOOK_A3_UNAVAILABLE");
  return data;
}
export async function readWordbookActivityDates(db: SupabaseClient, studentId: string, query: ReturnType<typeof parseWordbookQuery>) {
  if (!query.month) throw new Error("MONTH_REQUIRED");
  const { data, error } = await db.rpc("read_student_wordbook_activity_dates_v1", {
    p_student_id: studentId, p_domain: query.domain, p_timezone: query.timeZone, p_month: `${query.month}-01`
  });
  if (error || !Array.isArray(data)) throw new Error("WORDBOOK_A3_UNAVAILABLE");
  return { dates: data, domain: query.domain, month: query.month, timeZone: query.timeZone };
}
