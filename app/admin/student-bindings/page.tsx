import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { RoleGate, AdminOnly } from "@/components/RoleGate";
import { TeacherDataCacheProvider } from "@/components/TeacherDataCache";
import { StudentBindingsAdmin } from "@/components/admin/StudentBindingsAdmin";

export default function AdminStudentBindingsPage() {
  return (
    <RoleGate area="teacher">
      <TeacherDataCacheProvider>
        <AdminOnly>
          <TeacherAppShell
            crumbs={[
              { label: "首页", href: "/teacher/dashboard" },
              { label: "教师绑定" }
            ]}
            subtitle="配置每个学生的 Reading / Writing 教师绑定。本轮绑定不影响现有教师端权限。"
            title="教师绑定"
          >
            <StudentBindingsAdmin />
          </TeacherAppShell>
        </AdminOnly>
      </TeacherDataCacheProvider>
    </RoleGate>
  );
}