import Link from "next/link";
import { Plus } from "lucide-react";
import { AdminTeachersList } from "@/components/teacher/TeacherAccounts";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { AdminOnly } from "@/components/RoleGate";

export default function TeachersPage() {
  return <AdminOnly><TeacherAppShell action={<Link className="teacher-button-secondary bg-student-primary-soft" href="/teacher/accounts/teachers/new">新增教师 <Plus size={17} /></Link>} crumbs={[{ label: "首页", href: "/teacher/dashboard" }, { label: "账号", href: "/teacher/students" }, { label: "教师" }]} subtitle="查看教师账号及学生额度" title="教师账号"><AdminTeachersList /></TeacherAppShell></AdminOnly>;
}
