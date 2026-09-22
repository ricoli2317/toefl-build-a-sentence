import { redirect } from "next/navigation";
import { TeacherQuestionBankItemViewer } from "@/components/TeacherQuestionBank";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { parseLogicalPracticePage } from "@/lib/practiceLogicalCatalog";
import { isTeacherQuestionBankTaskType } from "@/lib/teacherReadingQuestionBank";

export default function TeacherQuestionBankItemPage({
  params,
  searchParams
}: {
  params: { monthKey: string };
  searchParams: { page?: string; taskType?: string };
}) {
  const itemId = decodeURIComponent(params.monthKey);
  if (/^\d{6}$/.test(itemId)) redirect("/teacher/question-bank");

  const returnTaskType = isTeacherQuestionBankTaskType(searchParams.taskType)
    ? searchParams.taskType
    : "build_sentence";
  const returnPage = parseLogicalPracticePage(searchParams.page ?? null) ?? 1;

  return (
    <TeacherAppShell title="题目详情">
      <TeacherQuestionBankItemViewer
        itemId={itemId}
        returnPage={returnPage}
        returnTaskType={returnTaskType}
      />
    </TeacherAppShell>
  );
}
