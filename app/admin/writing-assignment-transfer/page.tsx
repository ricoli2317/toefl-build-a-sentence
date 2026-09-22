import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { RoleGate, AdminOnly } from "@/components/RoleGate";
import { TeacherDataCacheProvider } from "@/components/TeacherDataCache";
import { WritingAssignmentTransfer } from "@/components/admin/WritingAssignmentTransfer";

export default function AdminWritingAssignmentTransferPage() {
  return (
    <RoleGate area="teacher">
      <TeacherDataCacheProvider>
        <AdminOnly>
          <TeacherAppShell
            crumbs={[
              { label: "首页", href: "/teacher/dashboard" },
              { label: "历史作业转移" }
            ]}
            subtitle="将 Admin 账号创建的历史 Writing 作业转移给普通教师"
            title="历史作业转移"
          >
            <WritingAssignmentTransfer />
          </TeacherAppShell>
        </AdminOnly>
      </TeacherDataCacheProvider>
    </RoleGate>
  );
}
