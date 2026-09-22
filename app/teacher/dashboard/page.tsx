import { TeacherHome } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherDashboardPage() {
  return (
    <TeacherAppShell title="教师端首页">
      <TeacherHome />
    </TeacherAppShell>
  );
}
