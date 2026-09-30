import { WrongQuestionsPractice } from "@/components/WrongQuestions";
import { StudentPage } from "@/components/student/StudentUI";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function StudentTodayWrongQuestionsPracticePage({
  searchParams
}: {
  searchParams: { returnTo?: string | string[] };
}) {
  return (
    <StudentPage title="Build a Sentence">
      <WrongQuestionsPractice
        returnTo={safeStudentReturnTo(searchParams.returnTo)}
        scope="today"
      />
    </StudentPage>
  );
}
