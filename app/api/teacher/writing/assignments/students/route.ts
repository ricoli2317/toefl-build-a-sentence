import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import { listVisibleStudentIds } from "@/lib/accountAccess";
import { isAssignmentSubject } from "@/lib/assignmentCatalog";
import {
  requireWritingAssignmentTeacher,
  writingAssignmentJson
} from "@/lib/writingAssignmentsServer";

export const dynamic = "force-dynamic";

type StudentRow = { id: string; email: string | null; full_name: string | null };

export async function GET(request: Request) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.actor) return writingAssignmentJson({ message: "无权访问教师端作业数据。" }, { status: 401 });
    // The eligible-student list follows the Assignment subject: a 阅读
    // Assignment can only be given to students bound for 阅读.
    const subjectParam = new URL(request.url).searchParams.get("subject");
    const subject = isAssignmentSubject(subjectParam) ? subjectParam : "writing";
    const studentIds = await listVisibleStudentIds(
      auth.supabase,
      auth.actor,
      auth.actor.role === "admin" ? undefined : subject
    );
    if (studentIds.length === 0) return writingAssignmentJson({ students: [] });
    const result = await readAllSupabaseRows<StudentRow>((from, to) =>
      auth.supabase!
        .from("profiles")
        .select("id,email,full_name")
        .eq("is_active", true)
        .in("id", studentIds)
        .order("full_name", { ascending: true, nullsFirst: false })
        .order("email", { ascending: true, nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, to)
    );
    if (result.error) throw result.error;
    return writingAssignmentJson({
      students: (result.data ?? []).map((student) => ({
        id: student.id,
        email: student.email ?? "",
        displayName: getPreferredUserDisplayName({
          email: student.email,
          profileFullName: student.full_name
        })
      }))
    });
  } catch (error) {
    console.error("[writing-assignments] students_load_failed", error);
    return writingAssignmentJson(
      { code: "STUDENTS_LOAD_FAILED", message: "学生列表加载失败，请稍后重试。" },
      { status: 500 }
    );
  }
}
