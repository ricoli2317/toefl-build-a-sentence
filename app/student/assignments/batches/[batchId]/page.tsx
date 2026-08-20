import { StudentWritingAssignmentCollectionDetail } from "@/components/student/StudentWritingAssignments";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentWritingAssignmentCollectionPage({
  params
}: {
  params: { batchId: string };
}) {
  return (
    <StudentPage
      subtitle="每篇写作都可以分别开始、保存草稿和提交。"
      title="作业详情"
    >
      <StudentWritingAssignmentCollectionDetail collectionId={params.batchId} />
    </StudentPage>
  );
}
