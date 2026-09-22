import { redirect } from "next/navigation";
import { TeacherQuestionBankItemViewer } from "@/components/TeacherQuestionBank";
import { TeacherReadingQuestionBankItemViewer } from "@/components/teacher/TeacherReadingQuestionBank";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { parseLogicalPracticePage } from "@/lib/practiceLogicalCatalog";
import {
  isReadingModuleTaskType,
  isTeacherQuestionBankTaskType
} from "@/lib/teacherReadingQuestionBank";

export default function TeacherQuestionBankItemPage({
  params,
  searchParams
}: {
  params: { monthKey: string };
  searchParams: { page?: string; taskType?: string };
}) {
  const itemId = decodeURIComponent(params.monthKey);
  if (/^\d{6}$/.test(itemId)) redirect("/teacher/question-bank");

  const requestedTaskType = isTeacherQuestionBankTaskType(searchParams.taskType)
    ? searchParams.taskType
    : null;
  const returnPage = parseLogicalPracticePage(searchParams.page ?? null) ?? 1;

  if (itemId.startsWith("reading-") || (requestedTaskType !== null && isReadingModuleTaskType(requestedTaskType))) {
    return (
      <TeacherReadingQuestionBankItemViewer
        itemId={itemId}
        returnModule={
          requestedTaskType !== null && isReadingModuleTaskType(requestedTaskType)
            ? requestedTaskType
            : "ctw"
        }
        returnPage={returnPage}
      />
    );
  }

  return (
    <TeacherAppShell title="题目详情">
      <TeacherQuestionBankItemViewer
        itemId={itemId}
        returnPage={returnPage}
        returnTaskType={requestedTaskType ?? "build_sentence"}
      />
    </TeacherAppShell>
  );
}
