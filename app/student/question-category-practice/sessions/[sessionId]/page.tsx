import { QuestionCategorySessionResult } from "@/components/reading/QuestionCategorySessionResult";
export default function CategoryResultPage({ params }: { params: { sessionId: string } }) {
  return <QuestionCategorySessionResult sessionId={params.sessionId} />;
}
