import { TeacherStudentAttemptResult } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";
import { firstSearchParamValue } from "@/lib/teacherNavigation";

export default function TeacherStudentAttemptResultPage({
  params,
  searchParams
}: {
  params: { attemptId: string; studentId: string };
  searchParams?: { returnTo?: string | string[] };
}) {
  return (
    <TeacherOnly>
    <TeacherAppShell
      subtitle="该学生本次练习的结果与逐题只读回看"
      title="练习结果"
    >
      <TeacherStudentAttemptResult
        attemptId={params.attemptId}
        returnTo={firstSearchParamValue(searchParams?.returnTo)}
        studentId={params.studentId}
      />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
