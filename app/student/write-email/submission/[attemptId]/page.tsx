import { WritingPractice } from "@/components/writing/WritingPractice";

export default function EmailSubmissionPage({
  params
}: {
  params: { attemptId: string };
}) {
  return (
    <WritingPractice
      attemptId={params.attemptId}
      mode="readonly"
      taskType="email"
    />
  );
}
