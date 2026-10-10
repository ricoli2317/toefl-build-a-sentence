import { TeacherOnly } from "@/components/RoleGate";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherStudentWordbook } from "@/components/teacher/TeacherStudentWordbook";
import { firstSearchParamValue } from "@/lib/teacherNavigation";

export default function Page({ params, searchParams }: {
  params: { studentId: string }; searchParams?: { returnTo?: string | string[]; domain?: string | string[] };
}) {
  return <TeacherOnly><TeacherAppShell title="复习历史" subtitle="只读查看学生已保存的复习记录">
    <TeacherStudentWordbook studentId={params.studentId} view="history" domain={firstSearchParamValue(searchParams?.domain) || undefined}
      returnTo={firstSearchParamValue(searchParams?.returnTo)} />
  </TeacherAppShell></TeacherOnly>;
}
