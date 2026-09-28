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
  searchParams: { page?: string; preview?: string; taskType?: string };
}) {
  const itemId = decodeURIComponent(params.monthKey);
  if (/^\d{6}$/.test(itemId)) redirect("/teacher/question-bank");

  const requestedTaskType = isTeacherQuestionBankTaskType(searchParams.taskType)
    ? searchParams.taskType
    : null;
  const returnPage = parseLogicalPracticePage(searchParams.page ?? null) ?? 1;
  // 查看题目 opens this page in a new tab with preview=1: the standalone mode
  // reuses the same read-only viewer but only shows the current question and
  // hides every navigation entry (shell, breadcrumbs, back, prev / next).
  const preview = searchParams.preview === "1";

  if (itemId.startsWith("reading-") || (requestedTaskType !== null && isReadingModuleTaskType(requestedTaskType))) {
    return (
      <TeacherReadingQuestionBankItemViewer
        itemId={itemId}
        preview={preview}
        returnModule={
          requestedTaskType !== null && isReadingModuleTaskType(requestedTaskType)
            ? requestedTaskType
            : "ctw"
        }
        returnPage={returnPage}
      />
    );
  }

  if (preview) {
    return (
      <div className="min-h-screen bg-student-bg" data-standalone-question-preview>
        <div className="mx-auto w-full max-w-4xl px-5 py-6">
          <TeacherQuestionBankItemViewer
            itemId={itemId}
            preview
            returnPage={returnPage}
            returnTaskType={requestedTaskType ?? "build_sentence"}
          />
        </div>
      </div>
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
