import Link from "next/link";
import { Plus } from "lucide-react";
import { StudentsAccountHome } from "@/components/admin/AdminStudents";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherStudentsPage() {
  return (
    <TeacherAppShell
      action={
        <Link className="teacher-button-secondary bg-student-primary-soft" href="/teacher/students/new">
          新增学生
          <Plus aria-hidden="true" size={17} strokeWidth={2} />
        </Link>
      }
      crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "账号" }
      ]}
      subtitle="管理学生与教师账号"
      title="账号"
    >
      <StudentsAccountHome />
    </TeacherAppShell>
  );
}
