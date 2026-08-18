import { redirect } from "next/navigation";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function AcademicDiscussionMonthPage() {
  redirect(STUDENT_ROUTES.academicDiscussion);
}
