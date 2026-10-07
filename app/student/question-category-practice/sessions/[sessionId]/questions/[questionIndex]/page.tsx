import { QuestionCategorySessionReview } from "@/components/reading/QuestionCategorySessionReview";
import { safeStudentReturnTo } from "@/lib/studentNavigation";
export default function CategoryReviewPage({ params, searchParams }: {
  params: { sessionId: string; questionIndex: string }; searchParams: { returnTo?: string | string[] };
}) {
  const index = Number(params.questionIndex);
  return <QuestionCategorySessionReview sessionId={params.sessionId} initialReviewIndex={Number.isInteger(index) && index >= 0 ? index : 0}
    returnTo={safeStudentReturnTo(searchParams.returnTo)} />;
}
