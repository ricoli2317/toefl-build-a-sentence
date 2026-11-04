import { StudentWritingCorrectionReview } from "@/components/student/StudentWritingCorrectionReview";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function Page({ params, searchParams }: { params: { attemptId: string }; searchParams: { returnTo?: string } }) {
  return <StudentWritingCorrectionReview attemptId={params.attemptId} backHref={safeStudentReturnTo(searchParams.returnTo) ?? "/student/writing-reviews"} />;
}
