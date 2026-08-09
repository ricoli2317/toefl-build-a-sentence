import { TeacherStudentQuestionDetail } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherStudentQuestionDetailPage({
  params
}: {
  params: { attemptAnswerId: string; studentId: string };
}) {
  return (
    <TeacherAppShell
      subtitle="查看学生本次完成结果并定位到指定题目"
      title="练习结果"
    >
      <TeacherStudentQuestionDetail attemptAnswerId={params.attemptAnswerId} />
    </TeacherAppShell>
  );
}
