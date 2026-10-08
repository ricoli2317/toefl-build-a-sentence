import { requireReadingAttemptStudent, readingAttemptJson } from "@/lib/reading/attemptServer";
import { createServiceSupabase } from "@/lib/supabase/server";
import { parseWordbookQuery } from "@/lib/lexical/wordbookList";
import { readWordbookActivityDates } from "@/lib/lexical/wordbookList.server";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.userId) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  let query;
  try {
    query = parseWordbookQuery(new URL(request.url).searchParams);
    if (!query.month) throw new Error("MONTH_REQUIRED");
  } catch { return readingAttemptJson({ error: "无效的活动月份参数。" }, { status: 400 }); }
  try { return readingAttemptJson(await readWordbookActivityDates(createServiceSupabase(), auth.userId, query)); }
  catch { return readingAttemptJson({ error: "活动日期暂不可用；请确认 A3 SQL 已安装。", code: "WORDBOOK_A3_UNAVAILABLE" }, { status: 503 }); }
}
