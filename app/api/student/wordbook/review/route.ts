import { requireReadingAttemptStudent, readingAttemptJson } from "@/lib/reading/attemptServer";
import { createServiceSupabase } from "@/lib/supabase/server";
import { parseReviewSettings, reviewObject, reviewPage, reviewUuid, ReviewError } from "@/lib/lexical/wordbookReview";
import { reviewRpc } from "@/lib/lexical/wordbookReview.server";
import { readReviewRound } from "@/lib/lexical/wordbookReviewRound.server";
import type { ReviewState } from "@/lib/lexical/wordbookReview";

export const dynamic = "force-dynamic";
function fail(error: unknown) {
  return readingAttemptJson({ error: error instanceof ReviewError ? error.message : "无效的复习请求。",
    code: error instanceof ReviewError ? error.code : "REVIEW_INVALID" }, { status: error instanceof ReviewError ? error.status : 400 });
}
export async function GET(request: Request) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.userId) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  try {
    const params = new URL(request.url).searchParams;
    const action = params.get("action");
    const allowed = action === "availability" ? ["action", "settings"] : ["action", "page"];
    params.forEach((_v, k) => { if (!allowed.includes(k) || params.getAll(k).length !== 1) throw new ReviewError("REVIEW_INVALID", 400, "无效参数。"); });
    if (action === "availability") {
      const settings = parseReviewSettings(JSON.parse(params.get("settings") ?? "null"));
      return readingAttemptJson(await reviewRpc(createServiceSupabase(), "wordbook_review_availability", { p_student: auth.userId, p_settings: settings }));
    }
    if (action !== "history") throw new ReviewError("REVIEW_INVALID", 400, "无效参数。");
    return readingAttemptJson(await reviewRpc(createServiceSupabase(), "wordbook_review_history", { p_student: auth.userId, p_page: reviewPage(params.get("page")) }));
  } catch (error) { return fail(error); }
}
export async function POST(request: Request) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.userId) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  try {
    const body = reviewObject(await request.json(), ["settings", "requestId"]);
    const settings = parseReviewSettings(body.settings), requestId = reviewUuid(body.requestId);
    const db = createServiceSupabase();
    const created = await reviewRpc(db, "wordbook_review_create", {
      p_student: auth.userId, p_settings: settings, p_request: requestId, p_parent: null
    }) as ReviewState;
    return readingAttemptJson(await readReviewRound(db, auth.userId, created.session.session_id));
  } catch (error) { return fail(error); }
}
