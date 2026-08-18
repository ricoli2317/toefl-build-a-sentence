import { redirect } from "next/navigation";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function WriteEmailMonthPage() {
  redirect(STUDENT_ROUTES.writeEmail);
}
