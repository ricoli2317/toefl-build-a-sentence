import { TeacherWritingAssignmentGroupEditForm } from "@/components/teacher/TeacherWritingAssignmentGroupEditForm";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";
import {
  firstSearchParamValue,
  safeTeacherReturnTo,
  teacherAssignmentBatchDetailHref,
  teacherReturnToHref,
  TEACHER_ASSIGNMENTS_HREF
} from "@/lib/teacherNavigation";

export default function TeacherWritingAssignmentGroupEditPage({
  params,
  searchParams
}: {
  params: { batchId: string };
  searchParams?: { returnTo?: string | string[] };
}) {
  const batchId = params.batchId?.trim() ?? "";
  // The crumb keeps a usable canonical parent; the form only propagates a
  // returnTo the teacher actually arrived with.
  const returnToParam = firstSearchParamValue(searchParams?.returnTo);
  const listReturnTo = safeTeacherReturnTo(returnToParam, TEACHER_ASSIGNMENTS_HREF);
  const detailHref = teacherReturnToHref(
    teacherAssignmentBatchDetailHref(batchId),
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
      subtitle="编辑整组作业的题目、学生与截止时间。"
      title="编辑作业"
    >
      <TeacherWritingAssignmentGroupEditForm
        batchId={batchId}
        returnTo={returnToParam}
      />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
