import { buildReadingHistoryPayload, type ReadingAttemptRow, type ReadingItemRow } from "@/lib/reading/history";
import { readingAttemptJson, requireReadingAttemptStudent } from "@/lib/reading/attemptServer";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) {
    return readingAttemptJson({ error: "请先登录后再查看阅读历史。" }, { status: 401 });
  }

  const { data: attempts, error: attemptError } = await auth.client
    .from("reading_attempts")
    .select("attempt_id,logical_item_id,task_type,elapsed_seconds,submitted_at,total_points,correct_points")
    .eq("status", "submitted")
    .order("submitted_at", { ascending: false })
    .order("attempt_id", { ascending: false });
  if (attemptError) {
    console.error("Reading history attempt load failed", { message: attemptError.message });
    return readingAttemptJson({ error: "阅读历史加载失败，请稍后重试。" }, { status: 500 });
  }

  const attemptRows = (attempts ?? []) as ReadingAttemptRow[];
  const itemIds = Array.from(new Set(attemptRows.map((attempt) => attempt.logical_item_id)));
  let items: ReadingItemRow[] = [];
  if (itemIds.length > 0) {
    const { data, error } = await createServiceSupabase()
      .from("reading_logical_items")
      .select("logical_item_id,module,title")
      .in("logical_item_id", itemIds);
    if (error) {
      console.error("Reading history item load failed", { message: error.message });
      return readingAttemptJson({ error: "阅读历史加载失败，请稍后重试。" }, { status: 500 });
    }
    items = (data ?? []) as ReadingItemRow[];
  }
  return readingAttemptJson(buildReadingHistoryPayload(attemptRows, items));
}
