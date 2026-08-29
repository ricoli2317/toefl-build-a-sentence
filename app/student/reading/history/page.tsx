import { redirect } from "next/navigation";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentReadingHistoryPage() {
  redirect(STUDENT_ROUTES.practiceHistory);
}
