import { ReadingFullSetSubmittedReview } from "@/components/reading/ReadingPractice";
import { parseReadingResultSource } from "@/lib/studentNavigation";

export default function ReadingFullSetSubmittedQuestionPage({
  params,
  searchParams
}: {
  params: { fullSetId: string; attemptId: string; questionIndex: string };
  searchParams: { source?: string | string[] };
}) {
  const questionIndex = Number(params.questionIndex);
  return (
    <ReadingFullSetSubmittedReview
      attemptId={params.attemptId}
      fullSetId={params.fullSetId}
      questionIndex={Number.isInteger(questionIndex) && questionIndex >= 0 ? questionIndex : 0}
      source={parseReadingResultSource(searchParams.source)}
    />
  );
}
