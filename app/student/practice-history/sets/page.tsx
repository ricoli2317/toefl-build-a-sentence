import { PracticeHistorySetList } from "@/components/PracticeHistory";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentPracticeHistorySetsPage({
  searchParams
}: {
  searchParams: { scope?: string };
}) {
  const scope = searchParams.scope === "today" ? "today" : "history";
  return (
    <StudentPage title={scope === "today" ? "今日练习套题" : "历史练习套题"}>
      <PracticeHistorySetList scope={scope} />
    </StudentPage>
  );
}
