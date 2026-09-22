import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherInactiveStudents } from "@/components/teacher/TeacherHomeDashboard";
import { TeacherOnly } from "@/components/RoleGate";

export default function TeacherInactiveStudentsPage() {
  return (
    <TeacherOnly>
      <TeacherAppShell
        crumbs={[
          { label: "首页", href: "/teacher/dashboard" },
          { label: "近 3 天未活跃学生" }
        ]}
        subtitle="仅列出学生姓名与最近一次练习时间"
        title="近 3 天未活跃学生"
      >
        <TeacherInactiveStudents />
      </TeacherAppShell>
    </TeacherOnly>
  );
}
