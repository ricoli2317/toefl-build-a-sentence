import { StudentPage } from "@/components/student/StudentUI";
import { WordbookReviewSetup } from "@/components/student/WordbookReview";

export default function ReviewPage({ searchParams }: { searchParams: { domain?: string } }) {
  return <StudentPage title="生词本复习"><WordbookReviewSetup initialDomain={searchParams.domain === "writing" ? "writing" : "reading"} /></StudentPage>;
}
