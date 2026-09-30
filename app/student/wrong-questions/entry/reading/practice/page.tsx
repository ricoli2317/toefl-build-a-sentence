import { ReadingWrongbookBankPractice } from "@/components/reading/ReadingWrongbookBankPractice";
import { isReadingModule } from "@/lib/reading/catalog";
import { StudentErrorState, StudentPage } from "@/components/student/StudentUI";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function EntryReadingWrongbookPracticePage({
  searchParams
}: {
  searchParams: {
    attemptId?: string;
    returnTo?: string | string[];
    taskType?: string;
  };
}) {
  const attemptId = searchParams.attemptId?.trim() ?? "";
  if (!attemptId || !isReadingModule(searchParams.taskType)) {
    return (
      <StudentPage title="阅读订正">
        <StudentErrorState text="订正入口无效，请从练习结果页重新进入。" />
      </StudentPage>
    );
  }
  return (
    <ReadingWrongbookBankPractice
      entryAttemptId={attemptId}
      mode="entry"
      returnTo={safeStudentReturnTo(searchParams.returnTo)}
      taskType={searchParams.taskType}
    />
  );
}
