import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { sortClassStudentCandidates } from "@/lib/teacherClasses";
import { listClassStudentCandidates } from "@/lib/teacherClasses.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    if (auth.error || !auth.userId) {
      return NextResponse.json(
        {
          code: "UNAUTHORIZED",
          error: auth.error === "Forbidden" ? "仅普通教师可以管理班级。" : "Unauthorized"
        },
        {
          status: auth.error === "Forbidden" ? 403 : 401,
          headers: { "Cache-Control": "no-store" }
        }
      );
    }

    const candidates = sortClassStudentCandidates(
      await listClassStudentCandidates(createServiceSupabase(), auth.userId)
    );
    return NextResponse.json(
      { students: candidates },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[teacher-classes] candidates_failed", error);
    return NextResponse.json(
      { code: "CLASS_STUDENTS_LOAD_FAILED", error: "学生列表加载失败，请稍后重试。" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
