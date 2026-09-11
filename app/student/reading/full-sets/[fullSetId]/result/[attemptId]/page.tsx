import { ReadingFullSetResult } from "@/components/reading/ReadingFullSetResult";
import { StudentPage } from "@/components/student/StudentUI";

export default function ReadingFullSetResultPage({
  params
}: {
  params: { fullSetId: string; attemptId: string };
}) {
  return (
    <StudentPage title="查看套题结果">
      <ReadingFullSetResult attemptId={params.attemptId} fullSetId={params.fullSetId} />
    </StudentPage>
  );
}
