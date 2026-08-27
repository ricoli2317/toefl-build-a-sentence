import { TeacherAccountDetail } from "@/components/teacher/TeacherAccounts";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { AdminOnly } from "@/components/RoleGate";

export default function TeacherDetailPage({ params }: { params: { teacherId: string } }) {
  return <AdminOnly><TeacherAppShell crumbs={[{ label: "首页", href: "/teacher/dashboard" }, { label: "账号", href: "/teacher/students" }, { label: "教师", href: "/teacher/accounts/teachers" }, { label: "教师详情" }]} subtitle="查看名下学生并单独调整额度" title="教师账号详情"><TeacherAccountDetail teacherId={params.teacherId} /></TeacherAppShell></AdminOnly>;
}
