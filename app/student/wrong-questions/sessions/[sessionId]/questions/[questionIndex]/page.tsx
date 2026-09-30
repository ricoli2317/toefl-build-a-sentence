import { ReadingWrongbookSessionReview } from "@/components/reading/ReadingWrongbookSessionReview";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function ReadingWrongbookSessionQuestionPage({
  params,
  searchParams
}: {
  params: { questionIndex: string; sessionId: string };
  searchParams: { returnTo?: string | string[] };
}) {
  const parsedIndex = Number(params.questionIndex);
  return (
    <ReadingWrongbookSessionReview
      initialReviewIndex={Number.isInteger(parsedIndex) && parsedIndex >= 0 ? parsedIndex : 0}
      returnTo={safeStudentReturnTo(searchParams.returnTo)}
      sessionId={params.sessionId}
    />
  );
}
