import { TeacherHome } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { firstSearchParamValue } from "@/lib/teacherNavigation";

export default function TeacherDashboardPage({
  searchParams
}: {
  searchParams?: { tab?: string | string[] };
}) {
  // The class list tab lives in the URL so breadcrumbs and the browser Back
  // button can return to 首页 with the class list context restored.
  const initialTab =
    firstSearchParamValue(searchParams?.tab) === "classes" ? "classes" : "students";

  return (
    <TeacherAppShell title="教师端首页">
      <TeacherHome initialTab={initialTab} />
    </TeacherAppShell>
  );
}
