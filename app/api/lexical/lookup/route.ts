import { requireReadingAttemptStudent, readingAttemptJson } from "@/lib/reading/attemptServer";
import { createServiceSupabase } from "@/lib/supabase/server";
import { parseLookupRequest } from "@/lib/lexical/lookup";
import { authorizeLexicalSource, lookupAuthorizedSelection, LexicalAccessError } from "@/lib/lexical/lookup.server";
import { loadOwnedReadingFullSetAttempt } from "@/lib/reading/fullSetAttemptServer";
import { readOwnedWritingAttempt, readWritingQuestion } from "@/lib/writingServer";
import { addWordbookStatus } from "@/lib/lexical/wordbook.server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { WritingReviewWorkspaceServerError } from "@/lib/writingReviewWorkspaceServer";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client || !auth.userId) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 150000) return readingAttemptJson({ error: "选择内容过长。" }, { status: 413 });
    const text = await request.text();
    if (text.length > 70000) return readingAttemptJson({ error: "选择内容过长。" }, { status: 413 });
    const selection = parseLookupRequest(JSON.parse(text));
    if (!selection) return readingAttemptJson({ error: "无效的选择。" }, { status: 400 });
    const teacher = selection.teacherReadonly ? await requireTeacherOnly(bearerToken(request)) : null;
    if (teacher && (teacher.error || !teacher.userId || teacher.role !== "teacher")) {
      return readingAttemptJson({ error: "当前页面不可查词。" }, { status: 403 });
    }
    const db = createServiceSupabase();
    const client = auth.client;
    const source = await authorizeLexicalSource(client, db, auth.userId, selection, {
      fullSetAttempt: id => loadOwnedReadingFullSetAttempt(client, id),
      writingAttempt: id => readOwnedWritingAttempt(client, auth.userId!, id),
      writingQuestion: a => readWritingQuestion(client, a.task_type, a.question_id, a.assignment_id),
      // Latest BAS results display the canonical answer for every submitted
      // question. Ownership/submission/question membership are enforced first.
      basFinalVisible: () => true
    }, teacher ? { userId: teacher.userId!, role: teacher.role! } : undefined);
    const result = await lookupAuthorizedSelection(db, selection, source);
    return readingAttemptJson(selection.teacherReadonly ? result : await addWordbookStatus(db, auth.userId, result));
  } catch (error) {
    if (error instanceof LexicalAccessError) return readingAttemptJson({ error: error.message }, { status: error.status });
    if (error instanceof WritingReviewWorkspaceServerError) return readingAttemptJson({ error: "当前页面不可查词。" }, { status: error.status });
    if (error instanceof SyntaxError) return readingAttemptJson({ error: "无效的选择。" }, { status: 400 });
    console.error("Lexical lookup failed", { message: error instanceof Error ? error.message : "unknown" });
    return readingAttemptJson({ error: "查词暂时不可用。" }, { status: 503 });
  }
}
