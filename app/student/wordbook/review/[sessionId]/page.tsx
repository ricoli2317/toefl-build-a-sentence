import { StudentPage } from "@/components/student/StudentUI";
import { WordbookReviewSession } from "@/components/student/WordbookReview";

export default function ReviewSessionPage({ params }: { params: { sessionId: string } }) {
  return <StudentPage title="生词本复习"><WordbookReviewSession sessionId={params.sessionId} /></StudentPage>;
}
