import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherWritingAiLogs } from "@/components/teacher/TeacherWritingAiLogs";

export default function TeacherWritingAiLogsPage({
  searchParams
}: {
  searchParams: { attempt_id?: string };
}) {
  return (
    <TeacherAppShell
      crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "写作批改", href: "/teacher/writing/reviews" },
        { label: "AI 调用日志" }
      ]}
      subtitle="查看 Writing AI 调用、失败阶段与结构化诊断"
      title="AI 调用日志"
    >
      <TeacherWritingAiLogs initialAttemptId={searchParams.attempt_id ?? ""} />
    </TeacherAppShell>
  );
}
