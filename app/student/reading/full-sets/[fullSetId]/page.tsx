import { ReadingFullSetDetail } from "@/components/reading/ReadingFullSetDetail";
import { StudentPage } from "@/components/student/StudentUI";

export default function ReadingFullSetDetailPage({
  params
}: {
  params: { fullSetId: string };
}) {
  return (
    <StudentPage
      subtitle="确认两个 Module 的题量、计时与作答流程。"
      title="套题准备"
    >
      <ReadingFullSetDetail fullSetId={params.fullSetId} />
    </StudentPage>
  );
}
