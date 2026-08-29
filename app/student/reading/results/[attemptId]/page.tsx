import { ReadingResult } from "@/components/reading/ReadingResult";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentReadingResultPage({
  params
}: {
  params: { attemptId: string };
}) {
  return (
    <StudentPage title="查看阅读结果">
      <ReadingResult attemptId={params.attemptId} />
    </StudentPage>
  );
}

