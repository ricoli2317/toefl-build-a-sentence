import { PracticeHistoryErrorSummary } from "@/components/PracticeHistory";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentPracticeHistoryErrorsPage({
  searchParams
}: {
  searchParams: { scope?: string };
}) {
  const scope = searchParams.scope === "today" ? "today" : "history";
  return (
    <StudentPage title={scope === "today" ? "今日错题汇总" : "历史错题汇总"}>
      <PracticeHistoryErrorSummary scope={scope} />
    </StudentPage>
  );
}
