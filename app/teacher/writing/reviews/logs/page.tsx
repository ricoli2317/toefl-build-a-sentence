import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";
import { TeacherWritingAiLogs } from "@/components/teacher/TeacherWritingAiLogs";
import {
  firstSearchParamValue,
  safeTeacherReturnTo,
  TEACHER_REVIEWS_HREF
} from "@/lib/teacherNavigation";

export default function TeacherWritingAiLogsPage({
  searchParams
}: {
  searchParams: { attempt_id?: string; returnTo?: string | string[] };
}) {
  // Opened from the review workspace (keeps its context) or from the review
  // list (falls back to it).
  const reviewReturnTo = safeTeacherReturnTo(
    firstSearchParamValue(searchParams.returnTo),
    TEACHER_REVIEWS_HREF
  );

  return (
    <TeacherOnly>
    <TeacherAppShell
      crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "写作批改", href: reviewReturnTo },
        { label: "AI 调用日志" }
      ]}
      subtitle="查看 Writing AI 调用、失败阶段与结构化诊断"
      title="AI 调用日志"
    >
      <TeacherWritingAiLogs initialAttemptId={searchParams.attempt_id ?? ""} />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
