import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherWritingReviewWorkspace } from "@/components/teacher/TeacherWritingReviewWorkspace";

export default function TeacherWritingReviewWorkspacePage({
  params
}: {
  params: { attemptId: string };
}) {
  return (
    <TeacherAppShell
      crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "写作批改", href: "/teacher/writing/reviews" },
        { label: "批改工作台" }
      ]}
      title="写作批改"
      workspace
    >
      <TeacherWritingReviewWorkspace attemptId={params.attemptId} />
    </TeacherAppShell>
  );
}
