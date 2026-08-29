import { ReadingSubmittedReview } from "@/components/reading/ReadingPractice";

export default function ReadingSubmittedQuestionPage({
  params
}: {
  params: { attemptId: string; questionIndex: string };
}) {
  const parsedIndex = Number(params.questionIndex);
  return (
    <ReadingSubmittedReview
      attemptId={params.attemptId}
      initialQuestionIndex={Number.isInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : 0}
    />
  );
}
