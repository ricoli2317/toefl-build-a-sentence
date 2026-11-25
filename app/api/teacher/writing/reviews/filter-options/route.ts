import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { loadTeacherScope } from "@/lib/teacherScope.server";
import type { WritingAssignmentRecipient } from "@/lib/writingAssignments";

export const dynamic = "force-dynamic";

/**
 * Lightweight source for the 写作批改 student filter.
 *
 * The options are the teacher's own writing-scope students (the same scope the
 * review lists query), not the loaded list pages, so the picker is complete
 * after the first request and never scans the submission history. The list
 * endpoint still applies the student filter before pagination.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    if (auth.error || !auth.userId) {
      return NextResponse.json(
        {
          code: "UNAUTHORIZED",
          message: auth.error === "Forbidden" ? "仅普通教师可以查看写作批改。" : "Unauthorized"
        },
        {
          status: auth.error === "Forbidden" ? 403 : 401,
          headers: { "Cache-Control": "no-store" }
        }
      );
    }

    const supabase = createServiceSupabase();
    const scope = await loadTeacherScope(supabase, {
      userId: auth.userId,
      role: auth.role!
    });
    const collator = new Intl.Collator("zh-Hans-CN");
    const students: WritingAssignmentRecipient[] = scope.writingStudentIds.map(
      (studentId) => ({
        student_id: studentId,
        student_name: scope.studentProfiles.get(studentId)?.displayName ?? ""
      })
    );
    students.sort(
      (left, right) =>
        collator.compare(left.student_name, right.student_name) ||
        left.student_id.localeCompare(right.student_id)
    );
    return NextResponse.json(
      { students },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("[writing-reviews] filter_options_load_failed", error);
    return NextResponse.json(
      {
        code: "WRITING_REVIEW_FILTER_OPTIONS_LOAD_FAILED",
        message: "学生筛选列表加载失败，请稍后重试。"
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
