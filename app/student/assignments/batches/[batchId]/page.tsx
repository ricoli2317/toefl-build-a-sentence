import { StudentWritingAssignmentCollectionDetail } from "@/components/student/StudentWritingAssignments";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentWritingAssignmentCollectionPage({
  params
}: {
  params: { batchId: string };
}) {
  return (
    <StudentPage
      subtitle="每一项作业都可以独立开始、继续和完成。"
      title="作业详情"
    >
      <StudentWritingAssignmentCollectionDetail collectionId={params.batchId} />
    </StudentPage>
  );
}
