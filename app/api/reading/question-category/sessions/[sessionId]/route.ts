import { readingAttemptJson, readingAttemptError, requireReadingAttemptStudent } from "@/lib/reading/attemptServer";
import { categoryAnswerRows, type CategorySessionPayload } from "@/lib/reading/questionCategory";
import { loadReadingAnswerDisclosures } from "@/lib/reading/reviewDisclosures.server";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { sessionId: string } }) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  const { data, error } = await auth.client.rpc("get_reading_question_category_session", { p_session_id: params.sessionId });
  if (error) return readingAttemptError(error, "练习加载失败，请稍后重试。");
  if (new URL(request.url).searchParams.get("review") === "1") {
    const payload = data as CategorySessionPayload;
    if (payload.session.status !== "completed") return readingAttemptJson({ error: "这次练习还没有完成。" }, { status: 409 });
    try {
      return readingAttemptJson({ ...payload,
        disclosures: await loadReadingAnswerDisclosures(createServiceSupabase(), categoryAnswerRows(payload.answers)) });
    } catch (failure) {
      return readingAttemptError(failure instanceof Error ? failure : null, "作答详情加载失败，请稍后重试。");
    }
  }
  return readingAttemptJson(data);
}
