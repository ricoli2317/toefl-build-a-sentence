import { NextResponse } from "next/server";
import { bearerToken, requireAdmin } from "@/lib/auth";
import { resolvePasswordResetRequest } from "@/lib/passwordResetRequests.server";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const json = (data: unknown, init?: ResponseInit) =>
  NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });

/**
 * Admin resolves a Teacher's forgot-password request. The acting account is
 * re-verified as Admin on the server; only Teacher-target requests are handled
 * here, so Student requests can never surface in the Admin teacher list.
 */
export async function POST(
  request: Request,
  { params }: { params: { requestId: string } }
) {
  const auth = await requireAdmin(bearerToken(request));
  if (auth.error || !auth.userId) {
    return json({ message: "仅管理员可以处理教师密码重置请求。" }, { status: 403 });
  }
  const adminId = auth.userId;

  const requestId = String(params.requestId ?? "").trim();
  if (!requestId) return json({ message: "无效的请求。" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as { decision?: unknown };
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject") {
    return json({ message: "无效的操作。" }, { status: 400 });
  }

  try {
    const db = createServiceSupabase();
    const outcome = await resolvePasswordResetRequest(db, {
      requestId,
      decision,
      resolverId: adminId,
      targetRole: "teacher",
      authorize: async () => true
    });
    if (!outcome.ok) return json({ message: outcome.message }, { status: outcome.status });
    return json({ status: outcome.status });
  } catch (error) {
    console.error("[admin-password-reset] resolve_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ message: "请求处理失败，请稍后重试。" }, { status: 500 });
  }
}
