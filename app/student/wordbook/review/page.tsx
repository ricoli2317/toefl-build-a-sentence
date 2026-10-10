import { WordbookReviewSetup } from "@/components/student/WordbookReview";

export default function ReviewPage({ searchParams }: { searchParams: { domain?: string } }) {
  return <WordbookReviewSetup initialDomain={searchParams.domain === "writing" ? "writing" : "reading"} />;
}
