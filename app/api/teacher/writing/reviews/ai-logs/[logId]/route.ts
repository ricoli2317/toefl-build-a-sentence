import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  projectWritingReviewAiLog,
  WRITING_REVIEW_AI_LOG_SAFE_COLUMNS
} from "@/lib/writingReviewAiLogProjection";
import { canManageWritingAttempt } from "@/lib/accountAccess";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { logId: string } }
) {
  const auth = await requireUserWithRole(bearerToken(request), "teacher");
  if (auth.error || !auth.userId || !auth.role) {
    return json(
      { code: "UNAUTHORIZED", message: auth.error ?? "Unauthorized" },
      auth.error === "Unauthorized" ? 403 : 401
    );
  }
  const supabase = createServiceSupabase();
  const { data, error } = await supabase
    .from("writing_review_ai_logs")
    .select(WRITING_REVIEW_AI_LOG_SAFE_COLUMNS.join(","))
    .eq("id", params.logId)
    .maybeSingle();
  if (error) {
    return json(
      { code: "WRITING_AI_LOG_LOAD_FAILED", message: "无法加载 AI 日志详情。" },
      500
    );
  }
  if (!data) {
    return json(
      { code: "WRITING_AI_LOG_NOT_FOUND", message: "AI 日志不存在。" },
      404
    );
  }
  const attemptId = String((data as unknown as Record<string, unknown>).attempt_id ?? "");
  if (!attemptId || !await canManageWritingAttempt(supabase, { userId: auth.userId, role: auth.role }, attemptId)) {
    return json({ code: "WRITING_AI_LOG_NOT_FOUND", message: "AI 日志不存在。" }, 404);
  }
  return json({
    log: projectWritingReviewAiLog(
      data as unknown as Record<string, unknown>,
      { includeDiagnostics: true }
    )
  });
}

function json(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}
