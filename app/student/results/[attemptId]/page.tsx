import { PracticeResult } from "@/components/PracticeResult";
import { StudentPage } from "@/components/student/StudentUI";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function StudentResultPage({
  params,
  searchParams
}: {
  params: { attemptId: string };
  searchParams: { returnTo?: string | string[]; setId?: string; source?: string };
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
        returnTo={safeStudentReturnTo(searchParams.returnTo)}
        source={source}
      />
    </StudentPage>
  );
}
