import { redirect } from "next/navigation";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentHistoryWrongQuestionsPage() {
  redirect(STUDENT_ROUTES.wrongQuestions);
}
