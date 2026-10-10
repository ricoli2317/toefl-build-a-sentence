import { TeacherOnly } from "@/components/RoleGate";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherStudentWordbook } from "@/components/teacher/TeacherStudentWordbook";
import { firstSearchParamValue } from "@/lib/teacherNavigation";

export default function Page({ params, searchParams }: {
  params: { studentId: string }; searchParams?: { returnTo?: string | string[] };
}) {
  return <TeacherOnly><TeacherAppShell title="学生生词本" subtitle="只读查看学生收藏的词汇与语境" wide>
    <TeacherStudentWordbook studentId={params.studentId} returnTo={firstSearchParamValue(searchParams?.returnTo)} />
  </TeacherAppShell></TeacherOnly>;
}
