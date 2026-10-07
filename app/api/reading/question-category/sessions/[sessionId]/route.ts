import { readingAttemptJson, readingAttemptError, requireReadingAttemptStudent } from "@/lib/reading/attemptServer";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { sessionId: string } }) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  const { data, error } = await auth.client.rpc("get_reading_question_category_session", { p_session_id: params.sessionId });
  if (error) return readingAttemptError(error, "练习加载失败，请稍后重试。");
  return readingAttemptJson(data);
}
