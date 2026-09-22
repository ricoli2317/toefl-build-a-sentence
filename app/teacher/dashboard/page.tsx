import { TeacherHome } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherDashboardPage() {
  return (
    <TeacherAppShell
      subtitle="平台管理与学生教学入口"
      title="教师端首页"
    >
      <TeacherHome />
    </TeacherAppShell>
  );
}
