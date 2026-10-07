import { QuestionCategorySessionReview } from "@/components/reading/QuestionCategorySessionReview";
export default function CategoryReviewPage({ params }: { params: { sessionId: string; questionIndex: string } }) {
  const index = Number(params.questionIndex);
  return <QuestionCategorySessionReview sessionId={params.sessionId} initialReviewIndex={Number.isInteger(index) && index >= 0 ? index : 0} />;
}
