import { TeacherQuestionBankMonths } from "@/components/TeacherQuestionBank";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherQuestionBankPage() {
  return (
    <TeacherAppShell
      subtitle="按月份浏览题库中的全部套题"
      title="查看所有套题"
    >
      <TeacherQuestionBankMonths />
    </TeacherAppShell>
  );
}
