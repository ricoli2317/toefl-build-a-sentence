import { requireReadingAttemptStudent, readingAttemptJson } from "@/lib/reading/attemptServer";
import { createServiceSupabase } from "@/lib/supabase/server";
import { parseWordbookQuery } from "@/lib/lexical/wordbookList";
import { readWordbookList } from "@/lib/lexical/wordbookList.server";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.userId) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  let query;
  try { query = parseWordbookQuery(new URL(request.url).searchParams); }
  catch { return readingAttemptJson({ error: "无效的生词本筛选参数。" }, { status: 400 }); }
  try { return readingAttemptJson(await readWordbookList(createServiceSupabase(), auth.userId, query)); }
  catch { return readingAttemptJson({ error: "生词本读取暂不可用；若尚未安装 A3 SQL，请完成安装后重试。", code: "WORDBOOK_A3_UNAVAILABLE" }, { status: 503 }); }
}
