import { WrongQuestionsPractice } from "@/components/WrongQuestions";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentTodayWrongQuestionsPracticePage({
  searchParams
}: {
  searchParams: { questionId?: string };
}) {
  return (
    <StudentPage title="Build a Sentence">
      <WrongQuestionsPractice mode="today" questionId={searchParams.questionId} />
    </StudentPage>
  );
}
