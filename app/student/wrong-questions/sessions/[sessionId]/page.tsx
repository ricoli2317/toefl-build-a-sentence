import { ReadingWrongbookSessionResult } from "@/components/reading/ReadingWrongbookSessionResult";
import { StudentPage } from "@/components/student/StudentUI";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function WrongQuestionSessionResultPage({
  params,
  searchParams
}: {
  params: { sessionId: string };
  searchParams: { returnTo?: string | string[] };
}) {
  return (
    <StudentPage title="查看阅读结果">
      <ReadingWrongbookSessionResult
        returnTo={safeStudentReturnTo(searchParams.returnTo)}
        sessionId={params.sessionId}
      />
    </StudentPage>
  );
}
