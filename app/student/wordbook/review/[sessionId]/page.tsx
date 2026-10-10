import { WordbookReviewSession } from "@/components/student/WordbookReview";

export default function ReviewSessionPage({ params }: { params: { sessionId: string } }) {
  return <WordbookReviewSession sessionId={params.sessionId} />;
}
