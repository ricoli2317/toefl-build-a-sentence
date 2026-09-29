import { ReadingFullSetRunner } from "@/components/reading/ReadingFullSetRunner";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function ReadingFullSetAttemptPage({
  params,
  searchParams
}: {
  params: { attemptId: string; fullSetId: string };
  searchParams: { returnTo?: string | string[] };
}) {
  return (
    <ReadingFullSetRunner
      attemptId={params.attemptId}
      expectedFullSetId={params.fullSetId}
      returnTo={safeStudentReturnTo(searchParams.returnTo)}
    />
  );
}
