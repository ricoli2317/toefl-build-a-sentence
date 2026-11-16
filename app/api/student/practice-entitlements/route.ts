import { NextResponse } from "next/server";
import { bearerToken, requireAuthenticatedAccount } from "@/lib/auth";
import {
  loadOwnStudentPracticeEntitlements,
  loadPracticeEntitlementEnforcementEnabled
} from "@/lib/practiceEntitlements.server";
import { createAnonSupabase, createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const json = (data: unknown, init?: ResponseInit) =>
  NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });

/**
 * Read-only Student self-service entitlement endpoint for later phases.
 *
 * There is deliberately no student_id parameter. The RPC derives the target
 * from auth.uid() only, so a Student cannot query another student's values.
 * No write method is exported here.
 */
export async function GET(request: Request) {
  try {
    const token = bearerToken(request);
    const auth = await requireAuthenticatedAccount(token);
    if (auth.error || !auth.userId || !token) {
      return json({ message: "请先登录。" }, { status: 401 });
    }
    if (auth.role !== "student") {
      return json(
        { message: "仅学生可以查看自己的练习额度。" },
        { status: 403 }
      );
    }

    let enforcementEnabled: boolean;
    try {
      enforcementEnabled = await loadPracticeEntitlementEnforcementEnabled(
        createServiceSupabase()
      );
    } catch (error) {
      console.error("[student-practice-entitlements] switch_read_failed", {
        message: error instanceof Error ? error.message : String(error)
      });
      return json(
        { message: "练习权限状态加载失败，请稍后重试。" },
        { status: 503 }
      );
    }

    const result = await loadOwnStudentPracticeEntitlements(
      createAnonSupabase(token)
    );
    if (!result.ok) {
      if (result.status >= 500) {
        console.error("[student-practice-entitlements] load_failed", {
          status: result.status
        });
      }
      return json({ message: result.message }, { status: result.status });
    }

    return json({
      entitlements: result.entitlements,
      enforcementEnabled,
      viewerRole: auth.role
    });
  } catch (error) {
    console.error("[student-practice-entitlements] request_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json(
      { message: "练习额度加载失败，请稍后重试。" },
      { status: 500 }
    );
  }
}
