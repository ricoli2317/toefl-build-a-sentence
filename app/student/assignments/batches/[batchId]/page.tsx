import { StudentWritingAssignmentCollectionDetail } from "@/components/student/StudentWritingAssignments";
import { StudentPage } from "@/components/student/StudentUI";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function StudentWritingAssignmentCollectionPage({
  params,
  searchParams
}: {
  params: { batchId: string };
  searchParams: { returnTo?: string | string[] };
}) {
  return (
    <StudentPage
      subtitle="每一项作业都可以独立开始、继续和完成。"
      title="作业详情"
    >
      <StudentWritingAssignmentCollectionDetail
        collectionId={params.batchId}
        returnTo={safeStudentReturnTo(searchParams.returnTo)}
      />
    </StudentPage>
  );
}
