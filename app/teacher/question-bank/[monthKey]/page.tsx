import { TeacherQuestionBankSets } from "@/components/TeacherQuestionBank";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherQuestionBankMonthPage({
  params
}: {
  params: { monthKey: string };
}) {
  const monthKey = decodeURIComponent(params.monthKey);

  return (
    <TeacherAppShell
      subtitle="查看该月份包含的套题"
      title="月份套题"
    >
      <TeacherQuestionBankSets monthKey={monthKey} />
    </TeacherAppShell>
  );
}
