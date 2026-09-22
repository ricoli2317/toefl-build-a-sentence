import { TeacherHome } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherDashboardPage() {
  return (
    <TeacherAppShell
      subtitle="教学工作概览与近期动态"
      title="教师端首页"
      wide
    >
      <TeacherHome />
    </TeacherAppShell>
  );
}
