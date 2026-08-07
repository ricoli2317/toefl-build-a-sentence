import { WrongQuestionsPractice } from "@/components/WrongQuestions";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentHistoryWrongQuestionsPracticePage({
  searchParams
}: {
  searchParams: { mode?: string };
}) {
  const mode = searchParams.mode === "random" ? "history-random" : "history-all";

  return (
    <StudentPage title="Build a Sentence">
      <WrongQuestionsPractice mode={mode} />
    </StudentPage>
  );
}
