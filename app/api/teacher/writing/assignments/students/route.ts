import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
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
    const result = await readAllSupabaseRows<StudentRow>((from, to) => {
      let query = auth.supabase!
        .from("profiles")
        .select("id,email,full_name")
        .eq("is_active", true);
      if (auth.actor!.role === "admin") {
        query = query.or(`role.eq.student,id.eq.${auth.actor!.userId}`);
      } else {
        query = query.eq("role", "student").eq("owner_id", auth.actor!.userId);
      }
      return query
        .order("full_name", { ascending: true, nullsFirst: false })
        .order("email", { ascending: true, nullsFirst: false })
        .order("id", { ascending: true })
        .range(from, to);
    });
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
