import { readingAttemptJson, readingAttemptError, requireReadingAttemptStudent } from "@/lib/reading/attemptServer";
import type { CategorySubmitPayload } from "@/lib/reading/questionCategory";

export const dynamic = "force-dynamic";
type Params = { sessionId: string; itemId: string };
export async function POST(request: Request, { params }: { params: Params }) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client || !auth.userId) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.answers) || !Number.isInteger(body.elapsedSeconds)
    || body.elapsedSeconds < 0 || body.elapsedSeconds > 604800
    || typeof body.finalize !== "boolean" || !Number.isSafeInteger(body.revision) || body.revision < 1
    || Object.keys(body).some((key) => !["answers", "elapsedSeconds", "finalize", "revision"].includes(key))) {
    return readingAttemptJson({ error: "提交的阅读答案无效。" }, { status: 400 });
  }
  const { data, error } = await auth.client.rpc("submit_reading_question_category_group", {
    p_session_id: params.sessionId, p_logical_item_id: params.itemId,
    p_elapsed_seconds: body.elapsedSeconds, p_answers: body.answers, p_finalize: body.finalize, p_revision: body.revision
  });
  if (error) return readingAttemptError(error, "阅读答案提交失败，请稍后重试。");
  const payload = data as CategorySubmitPayload;
  if (!payload?.session || !Array.isArray(payload.answers) || typeof payload.alreadySubmitted !== "boolean" || typeof payload.completedNow !== "boolean") {
    return readingAttemptJson({ error: "提交结果无效。" }, { status: 500 });
  }
  // Final wrong events are applied atomically INSIDE the RPC. Neither a group
  // save nor an HTTP retry may replay them or expose provisional wrong answers.
  return readingAttemptJson(payload);
}
export async function PATCH(request: Request, { params }: { params: Params }) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  const draft = await request.json().catch(() => null);
  const { error } = await auth.client.rpc("save_reading_question_category_draft", {
    p_session_id: params.sessionId, p_logical_item_id: params.itemId, p_draft: draft
  });
  if (error) return readingAttemptError(error, "练习进度保存失败，请稍后重试。");
  return readingAttemptJson({ saved: true });
}
