import { redirect } from "next/navigation";
import { QuestionCategoryPractice } from "@/components/reading/QuestionCategoryPractice";
import { CATEGORY_ROUTE, isReadingQuestionCategory } from "@/lib/reading/questionCategory";
import { normalizeWrongQuestionHistoryAmount } from "@/lib/wrongQuestionBank";

export default function CategoryPracticePage({ searchParams }: {
  searchParams: { questionCategory?: string; amount?: string; session?: string };
}) {
  const amount = normalizeWrongQuestionHistoryAmount(searchParams.amount);
  const category = isReadingQuestionCategory(searchParams.questionCategory) ? searchParams.questionCategory : undefined;
  const sessionId = searchParams.session?.trim();
  if (!sessionId && (!amount || !category)) redirect(CATEGORY_ROUTE);
  return <QuestionCategoryPractice questionCategory={category} amount={amount ?? undefined} sessionId={sessionId} />;
}
