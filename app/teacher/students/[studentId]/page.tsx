import { TeacherStudentSummary } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";
import { firstSearchParamValue } from "@/lib/teacherNavigation";

export default function TeacherStudentPage({
  params,
  searchParams
}: {
  params: { studentId: string };
  searchParams?: {
    date?: string | string[];
    returnTo?: string | string[];
    tasks?: string | string[];
  };
}) {
  return (
    <TeacherOnly>
    <TeacherAppShell
      subtitle="查看学生的练习概览"
      title="学生概览"
    >
      <TeacherStudentSummary
        initialDate={firstSearchParamValue(searchParams?.date)}
        initialTasks={firstSearchParamValue(searchParams?.tasks)}
        returnTo={firstSearchParamValue(searchParams?.returnTo)}
        studentId={params.studentId}
      />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
