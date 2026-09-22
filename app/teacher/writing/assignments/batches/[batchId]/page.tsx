import { TeacherWritingAssignmentCollectionDetailView } from "@/components/teacher/TeacherWritingAssignmentCollectionDetailView";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";

export default function TeacherWritingAssignmentCollectionPage({
  params
}: {
  params: { batchId: string };
}) {
  return (
    <TeacherOnly>
    <TeacherAppShell
      crumbs={[
        { href: "/teacher/writing/assignments", label: "作业管理" },
        { label: "作业详情" }
      ]}
      subtitle="查看每名学生的完成情况，并进入已提交作文的批改。"
      title="作业进度"
    >
      <TeacherWritingAssignmentCollectionDetailView collectionId={params.batchId} />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
