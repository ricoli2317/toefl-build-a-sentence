import { WritingSetList } from "@/components/writing/WritingCatalog";
import { StudentPage } from "@/components/student/StudentUI";
import { formatWritingMonthLabel } from "@/lib/writing";

export default function AcademicDiscussionMonthPage({
  params
}: {
  params: { monthKey: string };
}) {
  const monthLabel = formatWritingMonthLabel(params.monthKey);
  return (
    <StudentPage title={`${monthLabel} · Academic Discussion`}>
      <WritingSetList
        monthKey={params.monthKey}
        monthLabel={monthLabel}
        taskType="academic_discussion"
      />
    </StudentPage>
  );
}
