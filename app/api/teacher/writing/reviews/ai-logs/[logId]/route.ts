import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { logId: string } }
) {
  const auth = await requireUserWithRole(bearerToken(request), "teacher");
  if (auth.error || !auth.userId) {
    return json(
      { code: "UNAUTHORIZED", message: auth.error ?? "Unauthorized" },
      auth.error === "Unauthorized" ? 403 : 401
    );
  }
  const { data, error } = await createServiceSupabase()
    .from("writing_review_ai_logs")
    .select("*")
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
  return json({ log: data });
}

function json(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });
}
