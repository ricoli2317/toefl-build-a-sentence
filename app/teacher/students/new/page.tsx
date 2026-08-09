import { TeacherCreateStudent } from "@/components/TeacherCreateStudent";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherNewStudentPage() {
  return (
    <TeacherAppShell
      crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "学生", href: "/teacher/students" },
        { label: "新增学生" }
      ]}
      subtitle="创建学生账号并分配登录信息"
      title="新增学生"
    >
      <TeacherCreateStudent />
    </TeacherAppShell>
  );
}
