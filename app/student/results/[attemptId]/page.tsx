import { PracticeResult } from "@/components/PracticeResult";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentResultPage({
  params,
  searchParams
}: {
  params: { attemptId: string };
  searchParams: { setId?: string; source?: string };
}) {
  const source =
    searchParams.source === "practice-history" ||
    searchParams.source === "practice-history-today" ||
    searchParams.source === "practice-history-history"
      ? searchParams.source
      : undefined;
  return (
    <StudentPage title="查看结果">
      <PracticeResult
        attemptId={params.attemptId}
        historySetId={searchParams.setId}
        source={source}
      />
    </StudentPage>
  );
}
