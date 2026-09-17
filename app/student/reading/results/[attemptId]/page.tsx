import { ReadingResult } from "@/components/reading/ReadingResult";
import { StudentPage } from "@/components/student/StudentUI";
import { parseReadingResultSource } from "@/lib/studentNavigation";

export default function StudentReadingResultPage({
  params,
  searchParams
}: {
  params: { attemptId: string };
  searchParams: { source?: string | string[] };
}) {
  return (
    <StudentPage title="查看阅读结果">
      <ReadingResult
        attemptId={params.attemptId}
        source={parseReadingResultSource(searchParams.source)}
      />
    </StudentPage>
  );
}
