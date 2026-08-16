import { WritingSetList } from "@/components/writing/WritingCatalog";
import { StudentPage } from "@/components/student/StudentUI";
import { formatWritingMonthLabel } from "@/lib/writing";

export default function WriteEmailMonthPage({ params }: { params: { monthKey: string } }) {
  const monthLabel = formatWritingMonthLabel(params.monthKey);
  return (
    <StudentPage title={`${monthLabel} · Write an Email`}>
      <WritingSetList monthKey={params.monthKey} monthLabel={monthLabel} taskType="email" />
    </StudentPage>
  );
}
