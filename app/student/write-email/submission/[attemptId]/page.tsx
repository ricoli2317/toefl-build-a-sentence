import { WritingPractice } from "@/components/writing/WritingPractice";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function EmailSubmissionPage({
  params,
  searchParams
}: {
  params: { attemptId: string };
  searchParams: { returnTo?: string | string[] };
}) {
  return (
    <WritingPractice
      attemptId={params.attemptId}
      mode="readonly"
      returnTo={safeStudentReturnTo(searchParams.returnTo)}
      taskType="email"
    />
  );
}
