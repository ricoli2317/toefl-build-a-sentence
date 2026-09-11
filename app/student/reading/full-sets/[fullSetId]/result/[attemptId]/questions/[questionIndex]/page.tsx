import { ReadingFullSetSubmittedReview } from "@/components/reading/ReadingPractice";

export default function ReadingFullSetSubmittedQuestionPage({
  params
}: {
  params: { fullSetId: string; attemptId: string; questionIndex: string };
}) {
  const questionIndex = Number(params.questionIndex);
  return (
    <ReadingFullSetSubmittedReview
      attemptId={params.attemptId}
      fullSetId={params.fullSetId}
      questionIndex={Number.isInteger(questionIndex) && questionIndex >= 0 ? questionIndex : 0}
    />
  );
}
