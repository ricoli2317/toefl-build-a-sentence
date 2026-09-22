import { TeacherWritingAssignmentGroupEditForm } from "@/components/teacher/TeacherWritingAssignmentGroupEditForm";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";

export default function TeacherWritingAssignmentGroupEditPage({
  params
}: {
  params: { batchId: string };
}) {
  const batchId = params.batchId?.trim() ?? "";
  const detailHref = `/teacher/writing/assignments/batches/${encodeURIComponent(batchId)}`;

  return (
    <TeacherOnly>
    <TeacherAppShell
      crumbs={[
        { href: "/teacher/writing/assignments", label: "作业管理" },
        { href: detailHref, label: "作业详情" },
        { label: "编辑作业" }
      ]}
      subtitle="编辑整组作业的题目、学生与截止时间。"
      title="编辑作业"
    >
      <TeacherWritingAssignmentGroupEditForm batchId={batchId} />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
