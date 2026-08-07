import { WrongQuestionsHome } from "@/components/WrongQuestions";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentWrongQuestionsPage() {
  return (
    <StudentPage title="错题集">
      <WrongQuestionsHome />
    </StudentPage>
  );
}
