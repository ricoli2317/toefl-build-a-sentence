import { NextResponse } from "next/server";
import { bearerToken, requireAdmin } from "@/lib/auth";
import {
  validatePracticeEntitlementValues
} from "@/lib/practiceEntitlements";
import {
  loadAdminStudentPracticeEntitlements,
  saveAdminStudentPracticeEntitlements
} from "@/lib/practiceEntitlements.server";
import { createAnonSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (data: unknown, init?: ResponseInit) =>
  NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });

function targetStudentId(value: string) {
  const studentId = String(value ?? "").trim();
  return UUID_PATTERN.test(studentId) ? studentId : null;
}

/**
 * Admin-only practice entitlement panel API.
 *
 * The browser never receives a service-role key. Both reads and writes use the
 * caller's access token, and the database RPC re-checks the actual Admin profile
 * from auth.uid(). The Admin Students list never calls this route; the panel
 * loads it only when opened for one student.
 */
export async function GET(
  request: Request,
  { params }: { params: { studentId: string } }
) {
  try {
    const token = bearerToken(request);
    const auth = await requireAdmin(token);
    if (auth.error || !auth.userId || !token) {
      return json({ message: "仅管理员可以查看学生练习权限。" }, { status: 403 });
    }

    const studentId = targetStudentId(params.studentId);
    if (!studentId) return json({ message: "无效的学生。" }, { status: 400 });

    const result = await loadAdminStudentPracticeEntitlements(
      createAnonSupabase(token),
      studentId
    );
    if (!result.ok) {
      if (result.status >= 500) {
        console.error("[admin-practice-entitlements] load_failed", {
          studentId,
          status: result.status
        });
      }
      return json({ message: result.message }, { status: result.status });
    }

    return json({ studentId, entitlements: result.entitlements });
  } catch (error) {
    console.error("[admin-practice-entitlements] request_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json(
      { message: "练习额度加载失败，请稍后重试。" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { studentId: string } }
) {
  try {
    const token = bearerToken(request);
    const auth = await requireAdmin(token);
    if (auth.error || !auth.userId || !token) {
      return json({ message: "仅管理员可以修改学生练习权限。" }, { status: 403 });
    }

    const studentId = targetStudentId(params.studentId);
    if (!studentId) return json({ message: "无效的学生。" }, { status: 400 });

    const body = (await request.json().catch(() => ({}))) as {
      entitlements?: unknown;
      reason?: unknown;
    };
    const values = validatePracticeEntitlementValues(body.entitlements);
    if (!values.ok) return json({ message: values.error }, { status: 400 });
    if (body.reason !== undefined && typeof body.reason !== "string") {
      return json({ message: "无效的修改原因。" }, { status: 400 });
    }

    const reason = typeof body.reason === "string"
      ? body.reason.trim().slice(0, 500) || null
      : null;

    const result = await saveAdminStudentPracticeEntitlements(
      createAnonSupabase(token),
      studentId,
      values.values,
      reason
    );
    if (!result.ok) {
      if (result.status >= 500) {
        console.error("[admin-practice-entitlements] save_failed", {
          studentId,
          status: result.status
        });
      }
      return json({ message: result.message }, { status: result.status });
    }

    return json({ studentId, entitlements: result.entitlements });
  } catch (error) {
    console.error("[admin-practice-entitlements] request_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json(
      { message: "练习额度保存失败，请稍后重试。" },
      { status: 500 }
    );
  }
}
