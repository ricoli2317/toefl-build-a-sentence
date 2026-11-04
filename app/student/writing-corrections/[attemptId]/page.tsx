import { WritingCorrection } from "@/components/writing/WritingCorrection";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function WritingCorrectionPage({ params, searchParams }: {
  params: { attemptId: string }; searchParams: { returnTo?: string };
}) {
  return <WritingCorrection attemptId={params.attemptId} backHref={safeStudentReturnTo(searchParams.returnTo) ?? "/student/writing-reviews"} />;
}
