import { ReadingWrongbookReview } from "@/components/reading/ReadingWrongbookReview";

export default function ReadingWrongbookQuestionPage({
  params
}: {
  params: { attemptId: string; questionIndex: string };
}) {
  const parsedIndex = Number(params.questionIndex);
  return (
    <ReadingWrongbookReview
      attemptId={params.attemptId}
      initialQuestionIndex={Number.isInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : 0}
    />
  );
}
