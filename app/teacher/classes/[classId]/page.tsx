import { TeacherOnly } from "@/components/RoleGate";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherClassDetail } from "@/components/teacher/TeacherClassDetail";

export default function TeacherClassDetailPage({
  params
}: {
  params: { classId: string };
}) {
  return (
    <TeacherOnly>
      <TeacherAppShell
        crumbs={[
          { label: "首页", href: "/teacher/dashboard" },
          { label: "班级" }
        ]}
        subtitle="管理班级成员与班级作业"
        title="班级详情"
      >
        <TeacherClassDetail classId={params.classId} />
      </TeacherAppShell>
    </TeacherOnly>
  );
}
