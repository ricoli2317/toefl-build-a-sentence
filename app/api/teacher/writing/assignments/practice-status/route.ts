import { isAssignmentSubject } from "@/lib/assignmentCatalog";
import { loadAssignmentPracticeStatus } from "@/lib/assignmentPracticeStatus.server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { loadTeacherClassForAssignment } from "@/lib/teacherClasses.server";
import { loadTeacherScope } from "@/lib/teacherScope.server";
import {
  requireWritingAssignmentTeacher,
  writingAssignmentJson
} from "@/lib/writingAssignmentsServer";

export const dynamic = "force-dynamic";

/**
 * Practice badge state for the teacher Assignment catalog.
 *
 * The selection is sent in the body (a class or up to one teacher's whole
 * student list) so the request is never limited by URL length. The response
 * only carries item identities that have a badge; no attempt history, student
 * names or aggregates ever reach the client.
 *
 * Student mode is checked against the teacher's own visible students for the
 * requested subject; class mode reuses the exact class + subject guard of
 * Assignment creation. A failed load returns an error, never an empty
 * "un-practiced" result.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.teacherId || !auth.actor) {
      return writingAssignmentJson({ message: "无权访问教师端作业数据。" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const subject = body.subject;
    if (!isAssignmentSubject(subject)) {
      return writingAssignmentJson(
        { code: "INVALID_SUBJECT", message: "请选择有效的作业科目。" },
        { status: 400 }
      );
    }

    const scope = await loadTeacherScope(auth.supabase, auth.actor);
    const eligibleStudentIds = new Set(
      subject === "reading" ? scope.readingStudentIds : scope.writingStudentIds
    );
    const classId = typeof body.classId === "string" ? body.classId.trim() : "";
    let studentIds: string[] = [];
    if (classId) {
      const assignmentClass = await loadTeacherClassForAssignment(
        auth.supabase,
        auth.teacherId,
        classId,
        subject
      );
      if (!assignmentClass) {
        return writingAssignmentJson(
          {
            code: "INVALID_CLASS",
            message: subject === "reading"
              ? "所选班级不存在或不包含阅读科目。"
              : "所选班级不存在或不包含写作科目。"
          },
          { status: 400 }
        );
      }
      const members = await readAllSupabaseRows<{ student_id: string }>((from, to) =>
        auth.supabase!
          .from("class_members")
          .select("student_id")
          .eq("class_id", classId)
          .order("student_id", { ascending: true })
          .range(from, to)
      );
      if (members.error) throw members.error;
      // Class recipients are the creation-time member snapshot restricted to
      // active students holding the acting teacher's subject binding, exactly
      // like the Assignment RPC.
      studentIds = Array.from(
        new Set(
          (members.data ?? [])
            .map((row) => String(row.student_id))
            .filter((studentId) => eligibleStudentIds.has(studentId))
        )
      );
    } else {
      const requested = Array.isArray(body.studentIds)
        ? body.studentIds.map((value) => String(value).trim()).filter(Boolean)
        : [];
      studentIds = Array.from(new Set(requested));
      if (studentIds.some((studentId) => !eligibleStudentIds.has(studentId))) {
        return writingAssignmentJson(
          { code: "INVALID_STUDENTS", message: "所选学生中包含无效账号。" },
          { status: 400 }
        );
      }
    }

    const statuses = await loadAssignmentPracticeStatus(auth.supabase, {
      studentIds,
      subject
    });
    return writingAssignmentJson({ subject, statuses });
  } catch (error) {
    console.error("[writing-assignments] assignment_practice_status_failed", error);
    return writingAssignmentJson(
      {
        code: "ASSIGNMENT_PRACTICE_STATUS_FAILED",
        message: "练习状态加载失败，请稍后重试。"
      },
      { status: 500 }
    );
  }
}
