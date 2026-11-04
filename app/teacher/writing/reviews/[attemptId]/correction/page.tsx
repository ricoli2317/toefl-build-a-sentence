import { TeacherOnly } from "@/components/RoleGate";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherWritingCorrectionDetail } from "@/components/teacher/TeacherWritingCorrectionDetail";
import { safeWritingReviewReturnTo } from "@/lib/teacherWritingReviewNavigation";

export default function TeacherWritingCorrectionPage({ params, searchParams }: {
  params: { attemptId: string }; searchParams: { returnTo?: string };
}) {
  return <TeacherOnly><TeacherAppShell workspace title="订正稿" crumbs={[
    { label: "首页", href: "/teacher/dashboard" }, { label: "写作批改", href: "/teacher/writing/reviews" }, { label: "订正稿" }
  ]}><TeacherWritingCorrectionDetail attemptId={params.attemptId} returnTo={safeWritingReviewReturnTo(searchParams.returnTo)} /></TeacherAppShell></TeacherOnly>;
}
