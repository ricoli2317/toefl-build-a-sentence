import { requireReadingAttemptStudent, readingAttemptJson } from "@/lib/reading/attemptServer";
import { createServiceSupabase } from "@/lib/supabase/server";
import { parseLookupRequest } from "@/lib/lexical/lookup";
import { LexicalAccessError } from "@/lib/lexical/lookup.server";
import { operateWordbook } from "@/lib/lexical/wordbook.server";
import { WordbookError } from "@/lib/lexical/wordbookContext";
import { loadOwnedReadingFullSetAttempt } from "@/lib/reading/fullSetAttemptServer";
import { readOwnedWritingAttempt, readWritingQuestion } from "@/lib/writingServer";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client || !auth.userId) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 150000) return readingAttemptJson({ error: "选择内容过长。" }, { status: 413 });
    const text = await request.text();
    if (text.length > 70000) return readingAttemptJson({ error: "选择内容过长。" }, { status: 413 });
    const input = JSON.parse(text);
    if (!input || typeof input !== "object") return readingAttemptJson({ error: "无效的收藏请求。" }, { status: 400 });
    const selection = parseLookupRequest(input.selection);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!selection || !["save", "remove", "status"].includes(input.action)
      || typeof input.entryId !== "string" || !uuid.test(input.entryId)
      || typeof input.occurrenceId !== "string" || !uuid.test(input.occurrenceId))
      return readingAttemptJson({ error: "无效的收藏请求。" }, { status: 400 });
    const client = auth.client;
    return readingAttemptJson(await operateWordbook(createServiceSupabase(), client, auth.userId, selection,
      input.entryId, input.occurrenceId, input.action, {
        fullSetAttempt: id => loadOwnedReadingFullSetAttempt(client, id),
        writingAttempt: id => readOwnedWritingAttempt(client, auth.userId!, id),
        writingQuestion: a => readWritingQuestion(client, a.task_type, a.question_id, a.assignment_id),
        basFinalVisible: () => true
      }));
  } catch (error) {
    if (error instanceof WordbookError) return readingAttemptJson({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof LexicalAccessError) return readingAttemptJson({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return readingAttemptJson({ error: "无效的收藏请求。" }, { status: 400 });
    console.error("Wordbook operation failed", { message: error instanceof Error ? error.message : "unknown" });
    return readingAttemptJson({ error: "生词本暂时不可用，请稍后重试。" }, { status: 503 });
  }
}
