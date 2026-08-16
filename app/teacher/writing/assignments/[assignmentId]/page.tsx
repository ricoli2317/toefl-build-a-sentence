import { TeacherWritingAssignmentDetailView } from "@/components/teacher/TeacherWritingAssignmentDetailView";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherWritingAssignmentDetailPage({
  params
}: {
  params: { assignmentId: string };
}) {
  return (
    <TeacherAppShell
      crumbs={[{ href: "/teacher/writing/assignments", label: "作业管理" }, { label: "作业详情" }]}
      subtitle="查看题目与学生完成情况。"
      title="作业详情"
    >
      <TeacherWritingAssignmentDetailView assignmentId={params.assignmentId} />
    </TeacherAppShell>
  );
}
