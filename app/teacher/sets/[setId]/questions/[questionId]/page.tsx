import { TeacherSetQuestionDetail } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { AdminOnly } from "@/components/RoleGate";

export default function TeacherSetQuestionPage({
  params
}: {
  params: { questionId: string; setId: string };
}) {
  const setId = decodeURIComponent(params.setId);
  const questionId = decodeURIComponent(params.questionId);

  return (
    <AdminOnly>
    <TeacherAppShell
      subtitle="结合题目原貌查看作答统计"
      title="单题统计"
    >
      <TeacherSetQuestionDetail questionId={questionId} setId={setId} />
    </TeacherAppShell>
    </AdminOnly>
  );
}
