import { PracticeHistorySetAttempts } from "@/components/PracticeHistory";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentPracticeHistorySetAttemptsPage({
  params,
  searchParams
}: {
  params: { setId: string };
  searchParams: { scope?: string };
}) {
  const setId = decodeURIComponent(params.setId);
  const scope = searchParams.scope === "today" ? "today" : "history";
  return (
    <StudentPage title="查看练习记录">
      <PracticeHistorySetAttempts scope={scope} setId={setId} />
    </StudentPage>
  );
}
