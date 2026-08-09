import { TeacherDashboard } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherDashboardPage() {
  return (
    <TeacherAppShell
      subtitle="查看学生情况、分析套题表现、管理题库"
      title="教师首页"
    >
      <TeacherDashboard />
    </TeacherAppShell>
  );
}
