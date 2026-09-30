import { redirect } from "next/navigation";
import { ReadingWrongbookBankPractice } from "@/components/reading/ReadingWrongbookBankPractice";
import { ReadingFullSetWrongbookPractice } from "@/components/reading/ReadingFullSetWrongbookPractice";
import { isReadingModule } from "@/lib/reading/catalog";
import { safeStudentReturnTo } from "@/lib/studentNavigation";
import { normalizeWrongQuestionHistoryAmount } from "@/lib/wrongQuestionBank";

export default function HistoryReadingWrongbookPracticePage({
  searchParams
}: {
  searchParams: {
    amount?: string;
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
        scope="history"
        sourceAttemptId={searchParams.sourceAttemptId}
      />
    );
  }
  if (!isReadingModule(searchParams.taskType)) return null;
  const amount = normalizeWrongQuestionHistoryAmount(searchParams.amount);
  const sessionId = searchParams.session?.trim() || undefined;
  // "Practice all history questions" is cancelled: a fresh history practice
  // must come from the 5 / 10 / 15 / 20 chooser; a frozen session may resume.
  if (!sessionId && !amount) {
    redirect("/student/wrong-questions");
  }
  return (
    <ReadingWrongbookBankPractice
      amount={amount ?? undefined}
      mode="history"
      returnTo={safeStudentReturnTo(searchParams.returnTo)}
      sessionId={sessionId}
      taskType={searchParams.taskType}
    />
  );
}
