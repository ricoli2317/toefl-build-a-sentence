import { StudentsAccountHome } from "@/components/admin/AdminStudents";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherStudentHeaderActions } from "@/components/teacher/TeacherStudentHeaderActions";

export default function TeacherStudentsPage() {
  return (
    <TeacherAppShell
      action={<TeacherStudentHeaderActions />}
      crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "学生" }
      ]}
      subtitle="查看和管理学生"
      title="学生"
    >
      <StudentsAccountHome />
    </TeacherAppShell>
  );
}
