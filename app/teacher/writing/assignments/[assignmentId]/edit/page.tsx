import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";
import { TeacherWritingAssignmentEditForm } from "@/components/teacher/TeacherWritingAssignmentEditForm";

export default function EditTeacherWritingAssignmentPage({
  params
}: {
  params: { assignmentId: string };
}) {
  return (
    <TeacherOnly>
    <TeacherAppShell
      crumbs={[
        { href: "/teacher/writing/assignments", label: "作业管理" },
        { href: `/teacher/writing/assignments/${params.assignmentId}`, label: "作业详情" },
        { label: "编辑作业" }
      ]}
      subtitle="修改已撤回作业；已有提交时，题型与题目内容保持锁定。"
      title="编辑作业"
    >
      <TeacherWritingAssignmentEditForm assignmentId={params.assignmentId} />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
