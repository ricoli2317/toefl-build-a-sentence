import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherWritingReviewWorkspace } from "@/components/teacher/TeacherWritingReviewWorkspace";
import { safeWritingReviewReturnTo } from "@/lib/teacherWritingReviewNavigation";

export default function TeacherWritingReviewWorkspacePage({
  params,
  searchParams
}: {
  params: { attemptId: string };
  searchParams: { returnTo?: string | string[] };
}) {
  const returnTo = safeWritingReviewReturnTo(
    Array.isArray(searchParams.returnTo) ? searchParams.returnTo[0] : searchParams.returnTo
  );
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
      <TeacherWritingReviewWorkspace attemptId={params.attemptId} returnTo={returnTo} />
    </TeacherAppShell>
  );
}
