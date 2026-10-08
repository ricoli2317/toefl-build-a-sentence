import { requireReadingAttemptStudent, readingAttemptJson } from "@/lib/reading/attemptServer";
import { createServiceSupabase } from "@/lib/supabase/server";
import { parseWordbookBatchDelete } from "@/lib/lexical/wordbookManagement";
import { deleteWordbookBatch } from "@/lib/lexical/wordbookManagement.server";
import { WordbookError } from "@/lib/lexical/wordbookContext";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.userId) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  let input;
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 8000) throw new Error("删除请求过长。");
    const text = await request.text();
    if (text.length > 8000) throw new Error("删除请求过长。");
    input = parseWordbookBatchDelete(JSON.parse(text));
  } catch {
    return readingAttemptJson({ error: "无效的删除请求。", code: "WORDBOOK_BATCH_INVALID" }, { status: 400 });
  }
  try {
    return readingAttemptJson(await deleteWordbookBatch(createServiceSupabase(), auth.userId, input));
  } catch (error) {
    if (error instanceof WordbookError) return readingAttemptJson({ error: error.message, code: error.code }, { status: error.status });
    return readingAttemptJson({ error: "批量删除失败，请稍后重试。", code: "WORDBOOK_BATCH_UNAVAILABLE" }, { status: 503 });
  }
}
