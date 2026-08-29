import { TeacherReadingStatistics } from "@/components/reading/TeacherReadingStatistics";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherReadingStatisticsPage() {
  return (
    <TeacherAppShell
      crumbs={[{ label: "首页", href: "/teacher/dashboard" }, { label: "阅读统计" }]}
      subtitle="查看学生、练习和各题的基础阅读表现"
      title="阅读统计"
    >
      <TeacherReadingStatistics />
    </TeacherAppShell>
  );
}
