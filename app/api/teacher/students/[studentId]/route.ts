import { NextResponse } from "next/server";
import { canManageStudent } from "@/lib/accountAccess";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { renameStudentProfile, validateStudentFullName } from "@/lib/studentProfileName";

export const dynamic = "force-dynamic";

const json = (data: unknown, init?: ResponseInit) =>
  NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });

/**
 * Renames a student the current teacher can manage. Authorization is always
 * re-checked against teacher_student_bindings (reading or writing) for the
 * authenticated teacher; no teacher id is ever read from the request body and
 * the legacy account ownership column is never an access fallback.
 */
export async function PATCH(
  request: Request,
  { params }: { params: { studentId: string } }
) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    return json({ message: "无权修改该学生的姓名。" }, { status: 403 });
  }

  const studentId = String(params.studentId ?? "").trim();
  if (!studentId) return json({ message: "无效的学生。" }, { status: 400 });

  const body = (await request.json().catch(() => ({}))) as { fullName?: unknown };
  const name = validateStudentFullName(body.fullName);
  if (!name.ok) return json({ message: name.error }, { status: 400 });

  try {
    const supabase = createServiceSupabase();
    const allowed = await canManageStudent(
      supabase,
      { userId: auth.userId, role: auth.role },
      studentId
    );
    if (!allowed) return json({ message: "无权修改该学生的姓名。" }, { status: 403 });

    const student = await renameStudentProfile(supabase, {
      studentId,
      fullName: name.fullName
    });
    if (!student) return json({ message: "未找到该学生。" }, { status: 404 });

    return json({ student });
  } catch (error) {
    console.error("Teacher student rename failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ message: "学生姓名更新失败，请稍后重试。" }, { status: 500 });
  }
}
