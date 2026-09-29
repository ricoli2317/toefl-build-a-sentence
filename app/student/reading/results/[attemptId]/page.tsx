import { ReadingResult } from "@/components/reading/ReadingResult";
import { StudentPage } from "@/components/student/StudentUI";
import { parseReadingResultSource, safeStudentReturnTo } from "@/lib/studentNavigation";

export default function StudentReadingResultPage({
  params,
  searchParams
}: {
  params: { attemptId: string };
  searchParams: { returnTo?: string | string[]; source?: string | string[] };
}) {
  return (
    <StudentPage title="查看阅读结果">
      <ReadingResult
        attemptId={params.attemptId}
        returnTo={safeStudentReturnTo(searchParams.returnTo)}
        source={parseReadingResultSource(searchParams.source)}
      />
    </StudentPage>
  );
}
