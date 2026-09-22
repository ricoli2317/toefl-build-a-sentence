import { NextResponse } from "next/server";
import { bearerToken, requireAdmin } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { renameStudentProfile, validateStudentFullName } from "@/lib/studentProfileName";

export const dynamic = "force-dynamic";

const json = (data: unknown, init?: ResponseInit) =>
  NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });

/**
 * Admin platform-level student rename. The target must be an active student;
 * the login account, ownership, role, bindings, and all historical records are
 * never touched by this route.
 */
export async function PATCH(
  request: Request,
  { params }: { params: { studentId: string } }
) {
  const auth = await requireAdmin(bearerToken(request));
  if (auth.error || !auth.userId) {
    return json({ message: "仅管理员可以修改学生姓名。" }, { status: 403 });
  }

  const studentId = String(params.studentId ?? "").trim();
  if (!studentId) return json({ message: "无效的学生。" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as { fullName?: unknown };
  const name = validateStudentFullName(body.fullName);
  if (!name.ok) return json({ message: name.error }, { status: 400 });

  try {
    const student = await renameStudentProfile(createServiceSupabase(), {
      studentId,
      fullName: name.fullName
    });
    if (!student) return json({ message: "未找到该学生。" }, { status: 404 });

    return json({ student });
  } catch (error) {
    console.error("Admin student rename failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ message: "学生姓名更新失败，请稍后重试。" }, { status: 500 });
  }
}
