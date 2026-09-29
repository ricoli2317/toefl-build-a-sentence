import { ReadingFullSetDetail } from "@/components/reading/ReadingFullSetDetail";
import { StudentPage } from "@/components/student/StudentUI";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function ReadingFullSetDetailPage({
  params,
  searchParams
}: {
  params: { fullSetId: string };
  searchParams: { returnTo?: string | string[] };
}) {
  return (
    <StudentPage
      subtitle="确认两个 Module 的题量、计时与作答流程。"
      title="套题准备"
    >
      <ReadingFullSetDetail
        fullSetId={params.fullSetId}
        returnTo={safeStudentReturnTo(searchParams.returnTo)}
      />
    </StudentPage>
  );
}
