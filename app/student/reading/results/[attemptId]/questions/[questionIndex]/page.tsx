import { ReadingSubmittedReview } from "@/components/reading/ReadingPractice";
import { parseReadingResultSource } from "@/lib/studentNavigation";

export default function ReadingSubmittedQuestionPage({
  params,
  searchParams
}: {
  params: { attemptId: string; questionIndex: string };
  searchParams: { source?: string | string[] };
}) {
  const parsedIndex = Number(params.questionIndex);
  return (
    <ReadingSubmittedReview
      attemptId={params.attemptId}
      initialQuestionIndex={Number.isInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : 0}
      source={parseReadingResultSource(searchParams.source)}
    />
  );
}
