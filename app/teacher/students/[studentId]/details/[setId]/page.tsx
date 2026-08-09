import { TeacherStudentSetDetails } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherStudentSetDetailsPage({
  params
}: {
  params: { setId: string; studentId: string };
}) {
  const setId = decodeURIComponent(params.setId);

  return (
    <TeacherAppShell
      subtitle="查看该学生在本套题中的全部完成记录"
      title="套题练习记录"
    >
      <TeacherStudentSetDetails setId={setId} studentId={params.studentId} />
    </TeacherAppShell>
  );
}
