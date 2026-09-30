import { ReadingWrongbookReview } from "@/components/reading/ReadingWrongbookReview";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function ReadingWrongbookQuestionPage({
  params,
  searchParams
}: {
  params: { attemptId: string; questionIndex: string };
  searchParams: { returnTo?: string | string[] };
}) {
  const parsedIndex = Number(params.questionIndex);
  return (
    <ReadingWrongbookReview
      attemptId={params.attemptId}
      initialQuestionIndex={Number.isInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : 0}
      returnTo={safeStudentReturnTo(searchParams.returnTo)}
    />
  );
}
