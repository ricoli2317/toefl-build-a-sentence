import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";
import { TeacherWritingAssignmentEditForm } from "@/components/teacher/TeacherWritingAssignmentEditForm";
import {
  firstSearchParamValue,
  safeTeacherReturnTo,
  teacherAssignmentDetailHref,
  teacherReturnToHref,
  TEACHER_ASSIGNMENTS_HREF
} from "@/lib/teacherNavigation";

export default function EditTeacherWritingAssignmentPage({
  params,
  searchParams
}: {
  params: { assignmentId: string };
  searchParams?: { returnTo?: string | string[] };
}) {
  // The crumb keeps a usable canonical parent; the form only propagates a
  // returnTo the teacher actually arrived with.
  const returnToParam = firstSearchParamValue(searchParams?.returnTo);
  const listReturnTo = safeTeacherReturnTo(returnToParam, TEACHER_ASSIGNMENTS_HREF);
  const detailHref = teacherReturnToHref(
    teacherAssignmentDetailHref(params.assignmentId),
    listReturnTo
  );

  return (
    <TeacherOnly>
    <TeacherAppShell
      crumbs={[
        { href: listReturnTo, label: "作业管理" },
        { href: detailHref, label: "作业详情" },
        { label: "编辑作业" }
      ]}
      subtitle="修改已撤回作业；已有提交时，题型与题目内容保持锁定。"
      title="编辑作业"
    >
      <TeacherWritingAssignmentEditForm
        assignmentId={params.assignmentId}
        returnTo={returnToParam}
      />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
