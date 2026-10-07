import { readingAttemptJson, readingAttemptError, requireReadingAttemptStudent } from "@/lib/reading/attemptServer";
import { categoryAnswerRows, type CategorySessionPayload } from "@/lib/reading/questionCategory";
import { loadReadingAnswerDisclosures } from "@/lib/reading/reviewDisclosures.server";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { sessionId: string; itemId: string } }) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  const { data, error } = await auth.client.rpc("get_reading_question_category_session", { p_session_id: params.sessionId });
  if (error) return readingAttemptError(error, "作答加载失败，请稍后重试。");
  const payload = data as CategorySessionPayload;
  const group = payload.session.groups.find((group) => group.logicalItemId === params.itemId);
  if (!group || !payload.session.progress[params.itemId] || payload.session.status !== "completed") {
    return readingAttemptJson({ error: "没有找到已完成的练习作答。" }, { status: 409 });
  }
  const targets = new Set(group.targets.map((target) => target.questionId));
  const rows = categoryAnswerRows(payload.answers.filter((answer) => answer.logicalItemId === params.itemId && targets.has(answer.questionId)));
  try {
    // Lightweight review only. Canonical passage hydration belongs to the shared
    // runner cache, on demand for the current source + one neighbour, never all.
    return readingAttemptJson({ rows, disclosures: await loadReadingAnswerDisclosures(createServiceSupabase(), rows) });
  } catch (failure) {
    return readingAttemptError(failure instanceof Error ? failure : null, "作答加载失败，请稍后重试。");
  }
}
