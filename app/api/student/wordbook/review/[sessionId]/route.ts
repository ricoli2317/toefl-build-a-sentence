import { requireReadingAttemptStudent, readingAttemptJson } from "@/lib/reading/attemptServer";
import { createServiceSupabase } from "@/lib/supabase/server";
import { reviewObject, reviewPage, reviewUuid, ReviewError } from "@/lib/lexical/wordbookReview";
import { reviewRpc } from "@/lib/lexical/wordbookReview.server";
import { presentReviewState, type ReviewPresentation } from "@/lib/lexical/wordbookReviewPresentation";
import type { ReviewState } from "@/lib/lexical/wordbookReview";
import { readReviewRound } from "@/lib/lexical/wordbookReviewRound.server";

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
    params.forEach((_v, k) => { if (!["position", "errors", "page", "round"].includes(k) || params.getAll(k).length !== 1) throw new ReviewError("REVIEW_INVALID", 400, "无效参数。"); });
    if (params.has("round")) {
      if (params.get("round") !== "1" || Array.from(params.keys()).length !== 1) throw new ReviewError("REVIEW_INVALID", 400, "无效参数。");
      return readingAttemptJson(await readReviewRound(createServiceSupabase(), auth.userId, sessionId));
    }
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
    if (value?.action === "sync") {
      const body = reviewObject(value, ["action", "command"]);
      const command = reviewObject(body.command, ["id", "action", "itemId", "answer"]);
      reviewUuid(command.id); const itemId = reviewUuid(command.itemId);
      if (!["study_next", "repeat", "start_test", "answer", "advance"].includes(String(command.action))) throw new ReviewError("REVIEW_INVALID", 400, "无效同步操作。");
      if (command.action === "answer") {
        const answer = reviewObject(command.answer, ["spelling", "pos", "optionId"]);
        // The existing submit is idempotent per item and preserves authoritative
        // historical grading. It is now background persistence, never UI gating.
        const saved = await reviewRpc(createServiceSupabase(), "wordbook_review_submit", {
          p_student: auth.userId, p_session: sessionId, p_item: itemId, p_answer: answer
        }) as ReviewState;
        const actual = saved.item.answer?.student;
        if (!actual || Object.keys(actual).length !== Object.keys(answer).length || Object.keys(actual).some(k => actual[k as keyof typeof actual] !== answer[k]))
          throw new ReviewError("REVIEW_SYNC_CONFLICT", 409, "此题已在另一页面保存不同答案，请刷新核对；本地待同步记录仍保留。");
        await flow(auth.userId, sessionId, "answer", itemId, answer);
      } else {
        if (command.answer !== undefined) throw new ReviewError("REVIEW_INVALID", 400, "无效同步操作。");
        await flow(auth.userId, sessionId, String(command.action), itemId);
      }
      return readingAttemptJson({ acknowledged: command.id });
    }
    if (value?.action === "retry") {
      const body = reviewObject(value, ["action", "requestId"]);
      const db = createServiceSupabase();
      const created = await reviewRpc(db, "wordbook_review_create", {
        p_student: auth.userId, p_settings: {}, p_request: reviewUuid(body.requestId), p_parent: sessionId
      }) as ReviewState;
      return readingAttemptJson(await readReviewRound(db, auth.userId, created.session.session_id));
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
