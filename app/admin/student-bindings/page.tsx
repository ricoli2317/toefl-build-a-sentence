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
            subtitle="管理学生与教师之间的 Reading / Writing 教学绑定。绑定关系将决定教师可访问的学生及对应教学数据。"
            title="教师绑定"
          >
            <StudentBindingsAdmin />
          </TeacherAppShell>
        </AdminOnly>
      </TeacherDataCacheProvider>
    </RoleGate>
  );
}