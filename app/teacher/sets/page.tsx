import { TeacherSetsList } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { AdminOnly } from "@/components/RoleGate";

export default function TeacherSetsPage() {
  return (
    <AdminOnly>
    <TeacherAppShell
      crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "套题统计" }
      ]}
      subtitle="查看全部套题的整体表现"
      title="套题统计"
    >
      <TeacherSetsList />
    </TeacherAppShell>
    </AdminOnly>
  );
}
