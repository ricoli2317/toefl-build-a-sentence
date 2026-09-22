import { TeacherStudentSummary } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";

export default function TeacherStudentPage({ params }: { params: { studentId: string } }) {
  return (
    <TeacherOnly>
    <TeacherAppShell
      subtitle="查看学生的练习概览"
      title="学生概览"
    >
      <TeacherStudentSummary studentId={params.studentId} />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
