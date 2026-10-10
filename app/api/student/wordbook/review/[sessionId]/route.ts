import { requireReadingAttemptStudent, readingAttemptJson } from "@/lib/reading/attemptServer";
import { createServiceSupabase } from "@/lib/supabase/server";
import { reviewObject, reviewPage, reviewUuid, ReviewError } from "@/lib/lexical/wordbookReview";
import { reviewRpc } from "@/lib/lexical/wordbookReview.server";
import { presentReviewState, type ReviewPresentation } from "@/lib/lexical/wordbookReviewPresentation";
import type { ReviewState } from "@/lib/lexical/wordbookReview";

async function flow(student: string, session: string, action = "read", item: string | null = null, answer: unknown = null) {
  const data = await reviewRpc(createServiceSupabase(), "wordbook_review_flow_state", {
    p_student: student, p_session: session, p_action: action, p_item: item, p_answer: answer
  });
  return presentReviewState(data as ReviewState & { presentation: ReviewPresentation });
}

export const dynamic = "force-dynamic";
function fail(error: unknown) {
  return readingAttemptJson({ error: error instanceof ReviewError ? error.message : "无效的复习请求。",
    code: error instanceof ReviewError ? error.code : "REVIEW_INVALID" }, { status: error instanceof ReviewError ? error.status : 400 });
}
export async function GET(request: Request, context: { params: { sessionId: string } }) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.userId) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  try {
    const sessionId = reviewUuid(context.params.sessionId), params = new URL(request.url).searchParams;
    params.forEach((_v, k) => { if (!["position", "errors", "page"].includes(k) || params.getAll(k).length !== 1) throw new ReviewError("REVIEW_INVALID", 400, "无效参数。"); });
    if (params.get("errors") === "1" && !params.has("position"))
      return readingAttemptJson(await reviewRpc(createServiceSupabase(), "wordbook_review_errors", { p_student: auth.userId, p_session: sessionId, p_page: reviewPage(params.get("page")) }));
    if (params.has("errors") || params.has("page")) throw new ReviewError("REVIEW_INVALID", 400, "无效参数。");
    if (!params.has("position")) return readingAttemptJson(await flow(auth.userId, sessionId));
    return readingAttemptJson(await reviewRpc(createServiceSupabase(), "wordbook_review_read", {
      p_student: auth.userId, p_session: sessionId, p_position: params.has("position") ? reviewPage(params.get("position")) : null
    }));
  } catch (error) { return fail(error); }
}
export async function POST(request: Request, context: { params: { sessionId: string } }) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.userId) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  try {
    const sessionId = reviewUuid(context.params.sessionId), value = await request.json();
    if (value?.action === "retry") {
      const body = reviewObject(value, ["action", "requestId"]);
      return readingAttemptJson(await reviewRpc(createServiceSupabase(), "wordbook_review_create", {
        p_student: auth.userId, p_settings: {}, p_request: reviewUuid(body.requestId), p_parent: sessionId
      }));
    }
    const body = reviewObject(value, ["action", "itemId", "answer"]);
    if (["study_next", "repeat", "start_test", "advance"].includes(String(body.action))) {
      if (body.answer !== undefined) throw new ReviewError("REVIEW_INVALID", 400, "无效参数。");
      return readingAttemptJson(await flow(auth.userId, sessionId, String(body.action), reviewUuid(body.itemId)));
    }
    if (body.action !== "answer") throw new ReviewError("REVIEW_INVALID", 400, "无效参数。");
    const answer = reviewObject(body.answer, ["spelling", "pos", "optionId"]);
    return readingAttemptJson(await flow(auth.userId, sessionId, "answer", reviewUuid(body.itemId), answer));
  } catch (error) { return fail(error); }
}
