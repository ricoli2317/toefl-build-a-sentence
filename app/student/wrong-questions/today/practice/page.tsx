import { WrongQuestionsPractice } from "@/components/WrongQuestions";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentTodayWrongQuestionsPracticePage() {
  return (
    <StudentPage title="Build a Sentence">
      <WrongQuestionsPractice scope="today" />
    </StudentPage>
  );
}
