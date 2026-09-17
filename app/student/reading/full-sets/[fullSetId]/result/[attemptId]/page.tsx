import { ReadingFullSetResult } from "@/components/reading/ReadingFullSetResult";
import { StudentPage } from "@/components/student/StudentUI";
import { parseReadingResultSource } from "@/lib/studentNavigation";

export default function ReadingFullSetResultPage({
  params,
  searchParams
}: {
  params: { fullSetId: string; attemptId: string };
  searchParams: { source?: string | string[] };
}) {
  return (
    <StudentPage title="查看套题结果">
      <ReadingFullSetResult
        attemptId={params.attemptId}
        fullSetId={params.fullSetId}
        source={parseReadingResultSource(searchParams.source)}
      />
    </StudentPage>
  );
}
