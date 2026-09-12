import { ReadingWrongbookResult } from "@/components/reading/ReadingWrongbookResult";
import { StudentPage } from "@/components/student/StudentUI";

export default function ReadingWrongbookResultPage({
  params
}: {
  params: { attemptId: string };
}) {
  return (
    <StudentPage title="查看订正结果">
      <ReadingWrongbookResult attemptId={params.attemptId} />
    </StudentPage>
  );
}
