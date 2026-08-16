import { StudentWritingReviewResult } from "@/components/student/StudentWritingReview";
import { safeWritingReviewReturnTo } from "@/lib/studentNavigation";

export default function StudentWritingReviewResultPage({
  params,
  searchParams
}: {
  params: { attemptId: string };
  searchParams: { returnTo?: string | string[] };
}) {
  return (
    <StudentWritingReviewResult
      attemptId={params.attemptId}
      backHref={safeWritingReviewReturnTo(searchParams.returnTo)}
    />
  );
}
