import { WritingSubmissionHistory } from "@/components/writing/WritingSubmissionHistory";
import { StudentPage } from "@/components/student/StudentUI";

export default function EmailSubmissionHistoryPage({
  params
}: {
  params: { questionId: string };
}) {
  return (
    <StudentPage title="提交记录">
      <WritingSubmissionHistory questionId={params.questionId} taskType="email" />
    </StudentPage>
  );
}
