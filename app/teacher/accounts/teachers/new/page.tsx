import { CreateTeacherForm } from "@/components/teacher/TeacherAccounts";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { AdminOnly } from "@/components/RoleGate";

export default function NewTeacherPage() {
  return <AdminOnly><TeacherAppShell crumbs={[{ label: "首页", href: "/teacher/dashboard" }, { label: "账号", href: "/teacher/students" }, { label: "教师", href: "/teacher/accounts/teachers" }, { label: "新增教师" }]} subtitle="新增教师默认学生账号额度为 20" title="新增教师"><CreateTeacherForm /></TeacherAppShell></AdminOnly>;
}
