import { TeacherStudentSummary } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherStudentPage({ params }: { params: { studentId: string } }) {
  return (
    <TeacherAppShell
      subtitle="查看学生的练习概览"
      title="学生概览"
    >
      <TeacherStudentSummary studentId={params.studentId} />
    </TeacherAppShell>
  );
}
