import { SetList } from "@/components/SetList";
import { StudentPage } from "@/components/student/StudentUI";
import { formatPracticeMonthLabel } from "@/lib/studentNavigation";

export default function StudentMonthSetsPage({ params }: { params: { monthKey: string } }) {
  const monthLabel = formatPracticeMonthLabel(params.monthKey);

  return (
    <StudentPage title={`${monthLabel}套题练习`}>
      <SetList monthKey={params.monthKey} monthLabel={monthLabel} />
    </StudentPage>
  );
}
