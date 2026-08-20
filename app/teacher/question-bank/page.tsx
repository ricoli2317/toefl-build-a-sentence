import { TeacherQuestionBankCatalog } from "@/components/TeacherQuestionBank";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import {
  isLogicalPracticeTaskType,
  parseLogicalPracticePage
} from "@/lib/practiceLogicalCatalog";

export default function TeacherQuestionBankPage({
  searchParams
}: {
  searchParams: { page?: string; taskType?: string };
}) {
  const taskType = isLogicalPracticeTaskType(searchParams.taskType)
    ? searchParams.taskType
    : "build_sentence";
  const page = parseLogicalPracticePage(searchParams.page ?? null) ?? 1;

  return (
    <TeacherAppShell
      subtitle="浏览 Build a Sentence、Write an Email 和 Academic Discussion 题目"
      title="教师题库"
    >
      <TeacherQuestionBankCatalog page={page} taskType={taskType} />
    </TeacherAppShell>
  );
}
