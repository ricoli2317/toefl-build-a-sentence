import type { SupabaseClient } from "@supabase/supabase-js";
import { ReviewError, reviewCoverageMessage } from "./wordbookReview.ts";

// All RPCs below expose allowlisted public JSON. Candidate/private snapshot
// functions are deliberately not reachable from a client-controlled action.
export async function reviewRpc(db: SupabaseClient, name: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(name, args);
  if (error) {
    const message = error.message ?? "";
    const coverage = /REVIEW_COVERAGE_(?:COUNT:\d+|MISSING:[a-z_,]+|OVERLAP)/.exec(message);
    if (coverage) throw new ReviewError("REVIEW_COVERAGE", 409, reviewCoverageMessage(coverage[0]));
    if (error.code === "57014") throw new ReviewError("REVIEW_TIMEOUT", 503,
      "复习请求超时，暂时无法核算或创建复习；请稍后再试。");
    const insufficient = /REVIEW_INSUFFICIENT:(\d+)/.exec(message);
    if (insufficient) throw new ReviewError("REVIEW_INSUFFICIENT", 409, `实际可复习 ${insufficient[1]} 个词条，请调整数量。`);
    if (message.includes("REVIEW_EMPTY")) throw new ReviewError("REVIEW_EMPTY", 409, "当前范围没有可复习词条。");
    if (message.includes("REVIEW_NOT_FOUND")) throw new ReviewError("REVIEW_NOT_FOUND", 404, "未找到你的复习记录。");
    if (/REVIEW_INVALID|REVIEW_REQUEST_CONFLICT/.test(message) || error.code === "22007" || error.code === "22008")
      throw new ReviewError("REVIEW_INVALID", 400, "复习日期、题型或答案无效，请检查后重试。");
    if (message.includes("REVIEW_STUDENT_REQUIRED")) throw new ReviewError("REVIEW_FORBIDDEN", 403, "当前账号不能进行学生复习。");
    throw new ReviewError("REVIEW_UNAVAILABLE", 503, "复习服务暂不可用；若尚未安装复习 SQL，请先完成数据库安装。");
  }
  if (!data || typeof data !== "object") throw new ReviewError("REVIEW_UNAVAILABLE", 503, "复习结果未确认，请刷新后重试。");
  return data;
}
