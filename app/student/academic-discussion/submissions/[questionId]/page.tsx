import { WritingSubmissionHistory } from "@/components/writing/WritingSubmissionHistory";
import { StudentPage } from "@/components/student/StudentUI";

export default function AcademicDiscussionSubmissionHistoryPage({
  params
}: {
  params: { questionId: string };
}) {
  return (
    <StudentPage title="提交记录">
      <WritingSubmissionHistory
        questionId={params.questionId}
        taskType="academic_discussion"
      />
    </StudentPage>
  );
}
