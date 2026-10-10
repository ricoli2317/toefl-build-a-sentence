import { TeacherOnly } from "@/components/RoleGate";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherStudentWordbook } from "@/components/teacher/TeacherStudentWordbook";
import { firstSearchParamValue } from "@/lib/teacherNavigation";

export default function Page({ params, searchParams }: {
  params: { studentId: string; sessionId: string }; searchParams?: { returnTo?: string | string[]; domain?: string | string[] };
}) {
  return <TeacherOnly><TeacherAppShell title="历史结果" subtitle="只读查看学生复习结果">
    <TeacherStudentWordbook studentId={params.studentId} sessionId={params.sessionId} view="result"
      domain={firstSearchParamValue(searchParams?.domain) || undefined} returnTo={firstSearchParamValue(searchParams?.returnTo)} />
  </TeacherAppShell></TeacherOnly>;
}
