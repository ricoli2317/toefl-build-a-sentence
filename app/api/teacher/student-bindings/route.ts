import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { validateBindingDomains } from "@/lib/studentBindings";
import { createTeacherStudentBindings } from "@/lib/teacherStudentBindings";

export const dynamic = "force-dynamic";

const json = (data: unknown, init?: ResponseInit) => NextResponse.json(data, {
  ...init,
  headers: { ...init?.headers, "Cache-Control": "no-store" }
});

export async function POST(request: Request) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    const forbidden = auth.error === "Forbidden";
    return json(
      { message: forbidden ? "仅普通教师可以绑定学生。" : "登录状态已失效，请重新登录。" },
      { status: forbidden ? 403 : 401 }
    );
  }

  try {
    // teacherId is intentionally never read from the request body: the binding
    // always belongs to the currently authenticated teacher.
    const body = (await request.json().catch(() => ({}))) as {
      studentId?: unknown;
      domains?: unknown;
    };
    const studentId = typeof body.studentId === "string" ? body.studentId.trim() : "";
    if (!studentId) return json({ message: "请选择学生。" }, { status: 400 });
    const checkedDomains = validateBindingDomains(body.domains);
    if (!checkedDomains.ok) return json({ message: checkedDomains.error }, { status: 400 });

    const supabase = createServiceSupabase();
    const { data: student, error: studentError } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", studentId)
      .eq("role", "student")
      .eq("is_active", true)
      .maybeSingle();
    if (studentError) throw studentError;
    if (!student) return json({ message: "未找到有效的学生账号。" }, { status: 404 });

    const result = await createTeacherStudentBindings(supabase, {
      teacherId: auth.userId,
      studentId,
      domains: checkedDomains.domains
    });
    if (!result.ok) {
      console.error("[teacher-student-bindings] insert_failed", result.error);
      return json({ message: "绑定失败，请稍后重试。" }, { status: 500 });
    }
    if (result.created.length === 0) {
      return json(
        {
          code: "ALL_DOMAINS_BOUND",
          message: "该学生已绑定所选授课科目。",
          alreadyBound: result.alreadyBound
        },
        { status: 409 }
      );
    }

    return json(
      {
        studentId,
        created: result.created,
        alreadyBound: result.alreadyBound
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[teacher-student-bindings] failed", error);
    return json({ message: "绑定失败，请稍后重试。" }, { status: 500 });
  }
}
