import { TeacherWritingAssignmentForm } from "@/components/teacher/TeacherWritingAssignmentForm";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";
import {
  firstSearchParamValue,
  safeTeacherReturnTo,
  teacherAssignmentsListHref,
  TEACHER_ASSIGNMENTS_HREF
} from "@/lib/teacherNavigation";

export default function NewTeacherWritingAssignmentPage({
  searchParams
}: {
  searchParams?: {
    studentId?: string | string[];
    classId?: string | string[];
    returnTo?: string | string[];
  };
}) {
  const studentId = firstSearchParamValue(searchParams?.studentId);
  const classId = firstSearchParamValue(searchParams?.classId);
  // 布置作业 keeps the 作业管理 context it was opened from (班级作业 tab or a
  // student filter); a direct URL falls back to the default list.
  const listReturnTo = safeTeacherReturnTo(
    firstSearchParamValue(searchParams?.returnTo),
    studentId
      ? teacherAssignmentsListHref({ view: "students", studentId })
      : classId
        ? teacherAssignmentsListHref({ view: "class", classId })
        : TEACHER_ASSIGNMENTS_HREF
  );

  return (
    <TeacherOnly>
    <TeacherAppShell
      crumbs={[{ href: listReturnTo, label: "作业管理" }, { label: "布置作业" }]}
      subtitle="选择题目和学生，创建一项新的写作作业。"
      title="布置作业"
    >
      <TeacherWritingAssignmentForm initialClassId={classId} initialStudentId={studentId} />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
