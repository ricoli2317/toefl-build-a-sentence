import { ReadingWrongbookBankPractice } from "@/components/reading/ReadingWrongbookBankPractice";
import { ReadingFullSetWrongbookPractice } from "@/components/reading/ReadingFullSetWrongbookPractice";
import { isReadingModule } from "@/lib/reading/catalog";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function TodayReadingWrongbookPracticePage({
  searchParams
}: {
  searchParams: {
    returnTo?: string | string[];
    session?: string;
    sourceAttemptId?: string;
    taskType?: string;
  };
}) {
  if (searchParams.taskType === "full_set" && searchParams.sourceAttemptId) {
    return (
      <ReadingFullSetWrongbookPractice
        returnTo={safeStudentReturnTo(searchParams.returnTo)}
        scope="today"
        sourceAttemptId={searchParams.sourceAttemptId}
      />
    );
  }
  if (!isReadingModule(searchParams.taskType)) return null;
  return (
    <ReadingWrongbookBankPractice
      mode="today"
      returnTo={safeStudentReturnTo(searchParams.returnTo)}
      sessionId={searchParams.session?.trim() || undefined}
      taskType={searchParams.taskType}
    />
  );
}
