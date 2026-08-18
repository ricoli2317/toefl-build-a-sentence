import { redirect } from "next/navigation";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentMonthSetsPage() {
  redirect(STUDENT_ROUTES.buildASentence);
}
