import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { validateClassSubjects } from "@/lib/teacherClasses";
import { bindTeacherToClass } from "@/lib/teacherClasses.server";

export const dynamic = "force-dynamic";

const json = (data: unknown, init?: ResponseInit) => NextResponse.json(data, {
  ...init,
  headers: { ...init?.headers, "Cache-Control": "no-store" }
});

/**
 * Binds one existing class to the authenticated teacher for exactly the
 * selected subjects. The teacher id is never read from the body; the server
 * links the caller and backfills only the caller's missing
 * teacher_student_bindings for the selected subjects. Other teachers' links,
 * subjects and bindings are never touched. Repeated calls are idempotent and
 * reported with alreadyBound=true when the link already existed.
 */
export async function POST(request: Request) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    const forbidden = auth.error === "Forbidden";
    return json(
      { message: forbidden ? "仅普通教师可以绑定班级。" : "登录状态已失效，请重新登录。" },
      { status: forbidden ? 403 : 401 }
    );
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      classId?: unknown;
      subjects?: unknown;
    };
    const classId = typeof body.classId === "string" ? body.classId.trim() : "";
    if (!classId) return json({ message: "请选择班级。" }, { status: 400 });

    const subjects = validateClassSubjects(body.subjects);
    if (!subjects.ok) {
      return json({ code: "INVALID_SUBJECTS", message: subjects.error }, { status: 400 });
    }

    const result = await bindTeacherToClass(
      createServiceSupabase(),
      auth.userId,
      classId,
      subjects.subjects
    );
    if (!result.ok) {
      return json({ code: result.code, message: result.error }, { status: result.status });
    }

    return json(
      {
        classId,
        alreadyBound: result.alreadyBound,
        createdBindingCount: result.createdBindingCount,
        subjects: result.subjects,
        class: result.class
      },
      { status: result.alreadyBound ? 200 : 201 }
    );
  } catch (error) {
    console.error("[teacher-class-bindings] failed", error);
    return json({ message: "绑定班级失败，请稍后重试。" }, { status: 500 });
  }
}
