import { StudentPage } from "@/components/student/StudentUI";
import { QuestionCategoryPracticeHome } from "@/components/reading/QuestionCategoryPracticeHome";
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";

export default function QuestionCategoryPage() {
  return <StudentPage title={STUDENT_UI_TEXT.questionCategoryPractice}><QuestionCategoryPracticeHome /></StudentPage>;
}
