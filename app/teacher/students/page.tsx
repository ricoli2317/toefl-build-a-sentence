import Link from "next/link";
import { Plus } from "lucide-react";
import { TeacherStudentsList } from "@/components/TeacherDashboard";
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
        { label: "学生" }
      ]}
      subtitle="查看学生账号与学习情况"
      title="学生"
    >
      <TeacherStudentsList />
    </TeacherAppShell>
  );
}
