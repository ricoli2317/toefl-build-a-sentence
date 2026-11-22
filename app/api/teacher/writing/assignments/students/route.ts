import { loadTeacherScope } from "@/lib/teacherScope.server";
import {
  requireWritingAssignmentTeacher,
  writingAssignmentJson
} from "@/lib/writingAssignmentsServer";

export const dynamic = "force-dynamic";

/**
 * Assignment recipient candidates.
 *
 * 布置作业 now selects the student / class before the subject, so this list
 * carries every active student the acting teacher is bound to (any subject)
 * together with that student's own subject domains. The wizard intersects the
 * domains of the selected students to decide which subjects are offerable; the
 * creation API still re-validates every recipient for the submitted subject.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.actor) {
      return writingAssignmentJson({ message: "无权访问教师端作业数据。" }, { status: 401 });
    }
    const scope = await loadTeacherScope(auth.supabase, auth.actor);
    const collator = new Intl.Collator("zh-Hans-CN");
    const students = scope.visibleStudentIds
      .flatMap((studentId) => {
        const profile = scope.studentProfiles.get(studentId);
        if (!profile) return [];
        return [{
          id: studentId,
          email: profile.email,
          displayName: profile.displayName || "未命名学生",
          domains: scope.studentDomains.get(studentId) ?? []
        }];
      })
      .sort((left, right) =>
        collator.compare(left.displayName, right.displayName)
        || left.email.localeCompare(right.email)
        || left.id.localeCompare(right.id)
      );
    return writingAssignmentJson({ students });
  } catch (error) {
    console.error("[writing-assignments] students_load_failed", error);
    return writingAssignmentJson(
      { code: "STUDENTS_LOAD_FAILED", message: "学生列表加载失败，请稍后重试。" },
      { status: 500 }
    );
  }
}
