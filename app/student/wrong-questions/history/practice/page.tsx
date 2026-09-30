import { redirect } from "next/navigation";
import { WrongQuestionsPractice } from "@/components/WrongQuestions";
import { StudentErrorState, StudentPage } from "@/components/student/StudentUI";
import { safeStudentReturnTo } from "@/lib/studentNavigation";
import { normalizeWrongQuestionHistoryAmount } from "@/lib/wrongQuestionBank";

export default function StudentHistoryWrongQuestionsPracticePage({
  searchParams
}: {
  searchParams: {
    amount?: string;
    attemptId?: string;
    mode?: string;
    returnTo?: string | string[];
    scope?: string;
    session?: string;
  };
}) {
  const scope = searchParams.scope;
  const mode = searchParams.mode === "random" ? "random" : "all";
  const attemptId = searchParams.attemptId?.trim() || undefined;
  const amount = normalizeWrongQuestionHistoryAmount(searchParams.amount);
  const sessionId = searchParams.session?.trim() || undefined;

  if (
    (scope !== "entry" && scope !== "history")
    || (scope === "entry" && !attemptId)
  ) {
    return (
      <StudentPage title="Build a Sentence">
        <StudentErrorState text="订正作用域无效，请从错题集重新进入。" />
      </StudentPage>
    );
  }

  // "Practice all history questions" is cancelled: history practice must come
  // from the 5 / 10 / 15 / 20 chooser (or resume an already frozen session).
  // Manual `scope=history&mode=all` URLs fall back to the wrongbook home.
  if (scope === "history" && !sessionId && (mode !== "random" || !amount)) {
    redirect("/student/wrong-questions");
  }

  return (
    <StudentPage title="Build a Sentence">
      <WrongQuestionsPractice
        amount={amount ?? undefined}
        attemptId={attemptId}
        mode={mode}
        returnTo={safeStudentReturnTo(searchParams.returnTo)}
        scope={scope}
        sessionId={sessionId}
      />
    </StudentPage>
  );
}
