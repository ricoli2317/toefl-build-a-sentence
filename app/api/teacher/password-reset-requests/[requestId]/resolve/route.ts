import { NextResponse } from "next/server";
import { canManageStudent } from "@/lib/accountAccess";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { resolvePasswordResetRequest } from "@/lib/passwordResetRequests.server";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const json = (data: unknown, init?: ResponseInit) =>
  NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });

/**
 * Teacher resolves a Student's forgot-password request.
 *
 * Authorization is re-checked on the server against the live
 * teacher_student_bindings rows (reading or writing): the teacher id always
 * comes from the authenticated session and can never be chosen by the client.
 * Requests for Teacher accounts are rejected here; only Admin resolves those.
 */
export async function POST(
  request: Request,
  { params }: { params: { requestId: string } }
) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    return json({ message: "无权处理该请求。" }, { status: 403 });
  }
  const userId = auth.userId;
  const role = auth.role;

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
      resolverId: userId,
      targetRole: "student",
      authorize: (row) => canManageStudent(db, { userId, role }, row.user_id)
    });
    if (!outcome.ok) return json({ message: outcome.message }, { status: outcome.status });
    return json({ status: outcome.status });
  } catch (error) {
    console.error("[teacher-password-reset] resolve_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ message: "请求处理失败，请稍后重试。" }, { status: 500 });
  }
}
