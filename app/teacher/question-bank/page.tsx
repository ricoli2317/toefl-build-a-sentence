import { TeacherQuestionBankCatalog } from "@/components/TeacherQuestionBank";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { parseLogicalPracticePage } from "@/lib/practiceLogicalCatalog";
import { isTeacherQuestionBankTaskType } from "@/lib/teacherReadingQuestionBank";

export default function TeacherQuestionBankPage({
  searchParams
}: {
  searchParams: { page?: string; taskType?: string };
}) {
  const taskType = isTeacherQuestionBankTaskType(searchParams.taskType)
    ? searchParams.taskType
    : "build_sentence";
  const page = parseLogicalPracticePage(searchParams.page ?? null) ?? 1;

  return (
    <TeacherAppShell
      subtitle="浏览阅读/写作题库"
      title="教师题库"
    >
      <TeacherQuestionBankCatalog page={page} taskType={taskType} />
    </TeacherAppShell>
  );
}
