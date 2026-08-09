import { TeacherSetQuestionDetail } from "@/components/TeacherDashboard";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherSetQuestionPage({
  params
}: {
  params: { questionId: string; setId: string };
}) {
  const setId = decodeURIComponent(params.setId);
  const questionId = decodeURIComponent(params.questionId);

  return (
    <TeacherAppShell
      subtitle="结合题目原貌查看作答统计"
      title="单题统计"
    >
      <TeacherSetQuestionDetail questionId={questionId} setId={setId} />
    </TeacherAppShell>
  );
}
