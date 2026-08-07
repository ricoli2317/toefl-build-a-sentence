import { redirect } from "next/navigation";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentRootPage() {
  redirect(STUDENT_ROUTES.home);
}
