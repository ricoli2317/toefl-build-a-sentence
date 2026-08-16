import { WritingPractice } from "@/components/writing/WritingPractice";

export default function AcademicDiscussionSubmissionPage({
  params
}: {
  params: { attemptId: string };
}) {
  return (
    <WritingPractice
      attemptId={params.attemptId}
      mode="readonly"
      taskType="academic_discussion"
    />
  );
}
