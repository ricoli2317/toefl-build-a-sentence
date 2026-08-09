import { TeacherQuestionBankSetViewer } from "@/components/TeacherQuestionBank";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherQuestionBankSetPage({
  params
}: {
  params: { monthKey: string; setId: string };
}) {
  const monthKey = decodeURIComponent(params.monthKey);
  const setId = decodeURIComponent(params.setId);

  return (
    <TeacherAppShell
      subtitle="以学生端相同的题目样式预览题目"
      title="题目预览"
    >
      <TeacherQuestionBankSetViewer monthKey={monthKey} setId={setId} />
    </TeacherAppShell>
  );
}
