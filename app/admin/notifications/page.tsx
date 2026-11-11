import { AdminOnly, RoleGate } from "@/components/RoleGate";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { NotificationsAdmin } from "@/components/admin/NotificationsAdmin";

export default function AdminNotificationsPage() {
  return <RoleGate area="teacher"><AdminOnly>
    <TeacherAppShell title="通知管理" subtitle="统一发布面向教师和学生的全站通知。"
      crumbs={[{ label: "首页", href: "/teacher/dashboard" }, { label: "通知管理" }]}>
      <NotificationsAdmin />
    </TeacherAppShell>
  </AdminOnly></RoleGate>;
}
