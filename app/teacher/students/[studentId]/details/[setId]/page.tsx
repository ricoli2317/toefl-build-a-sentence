import { TeacherStudentSetDetails } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";
import { firstSearchParamValue } from "@/lib/teacherNavigation";

export default function TeacherStudentSetDetailsPage({
  params,
  searchParams
}: {
  params: { setId: string; studentId: string };
  searchParams?: { returnTo?: string | string[] };
}) {
  const setId = decodeURIComponent(params.setId);

  return (
    <TeacherOnly>
    <TeacherAppShell
      subtitle="查看该学生在本套题中的全部完成记录"
      title="套题练习记录"
    >
      <TeacherStudentSetDetails
        returnTo={firstSearchParamValue(searchParams?.returnTo)}
        setId={setId}
        studentId={params.studentId}
      />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
