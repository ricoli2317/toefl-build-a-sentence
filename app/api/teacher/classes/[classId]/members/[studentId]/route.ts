import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  loadTeacherClassDetail,
  loadTeacherClassRow,
  removeTeacherClassMember
} from "@/lib/teacherClasses.server";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: { classId: string; studentId: string } }
) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    if (auth.error || !auth.userId) {
      return json(
        {
          code: "UNAUTHORIZED",
          error: auth.error === "Forbidden" ? "仅普通教师可以管理班级。" : "Unauthorized"
        },
        { status: auth.error === "Forbidden" ? 403 : 401 }
      );
    }

    const db = createServiceSupabase();
    const classRow = await loadTeacherClassRow(db, auth.userId, params.classId);
    if (!classRow) {
      return json({ code: "CLASS_NOT_FOUND", error: "班级不存在或无权操作。" }, { status: 404 });
    }

    // Leaving a class only deletes the membership; the teacher's
    // reading/writing bindings for this student always stay untouched.
    const result = await removeTeacherClassMember(
      db,
      auth.userId,
      params.classId,
      params.studentId
    );
    if (!result.ok) {
      return json({ code: result.code, error: result.error }, { status: result.status });
    }

    const detail = await loadTeacherClassDetail(db, auth.userId, params.classId);
    if (!detail) return json({ code: "CLASS_NOT_FOUND", error: "班级不存在或无权查看。" }, { status: 404 });
    return json({ class: detail.class, detail });
  } catch (error) {
    console.error("[teacher-classes] remove_member_failed", error);
    return json({ code: "CLASS_MEMBER_REMOVE_FAILED", error: "移除学生失败，请稍后重试。" }, { status: 500 });
  }
}
