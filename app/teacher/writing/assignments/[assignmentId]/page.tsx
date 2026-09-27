import { TeacherWritingAssignmentDetailView } from "@/components/teacher/TeacherWritingAssignmentDetailView";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";
import {
  firstSearchParamValue,
  safeTeacherReturnTo,
  TEACHER_ASSIGNMENTS_HREF
} from "@/lib/teacherNavigation";

export default function TeacherWritingAssignmentDetailPage({
  params,
  searchParams
}: {
  params: { assignmentId: string };
  searchParams?: { returnTo?: string | string[] };
}) {
  // The parent crumb returns to the exact 作业管理 state the teacher left
  // (班级作业 tab + class filter, or a student filter); a direct URL falls
  // back to the default 作业管理 list.
  const listReturnTo = safeTeacherReturnTo(
    firstSearchParamValue(searchParams?.returnTo),
    TEACHER_ASSIGNMENTS_HREF
  );

  return (
    <TeacherOnly>
    <TeacherAppShell
      crumbs={[{ href: listReturnTo, label: "作业管理" }, { label: "作业详情" }]}
      subtitle="查看题目与学生完成情况。"
      title="作业详情"
    >
      <TeacherWritingAssignmentDetailView
        assignmentId={params.assignmentId}
        returnTo={listReturnTo}
      />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
