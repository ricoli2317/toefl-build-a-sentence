import { ReadingFullSetResult } from "@/components/reading/ReadingFullSetResult";
import { StudentPage } from "@/components/student/StudentUI";
import { parseReadingResultSource, safeStudentReturnTo } from "@/lib/studentNavigation";

export default function ReadingFullSetResultPage({
  params,
  searchParams
}: {
  params: { fullSetId: string; attemptId: string };
  searchParams: { returnTo?: string | string[]; source?: string | string[] };
}) {
  return (
    <StudentPage title="查看套题结果">
      <ReadingFullSetResult
        attemptId={params.attemptId}
        fullSetId={params.fullSetId}
        returnTo={safeStudentReturnTo(searchParams.returnTo)}
        source={parseReadingResultSource(searchParams.source)}
      />
    </StudentPage>
  );
}
