import { WritingPractice } from "@/components/writing/WritingPractice";

export default function AcademicDiscussionPracticePage({
  params,
  searchParams
}: {
  params: { questionId: string };
  searchParams: { attempt?: string; new?: string };
}) {
  return (
    <WritingPractice
      attemptId={searchParams.attempt}
      forceNew={searchParams.new === "1"}
      questionId={params.questionId}
      taskType="academic_discussion"
    />
  );
}
