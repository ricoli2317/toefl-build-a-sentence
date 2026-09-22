import { TeacherSetQuestionDetail } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";

export default function TeacherSetQuestionPage({
  params
}: {
  params: { questionId: string; setId: string };
}) {
  const setId = decodeURIComponent(params.setId);
  const questionId = decodeURIComponent(params.questionId);

  return (
    <TeacherOnly>
    <TeacherAppShell
      subtitle="结合题目原貌查看作答统计"
      title="单题统计"
    >
      <TeacherSetQuestionDetail questionId={questionId} setId={setId} />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
