import { MonthList } from "@/components/SetList";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentPracticeSetsPage() {
  return (
    <StudentPage title="按月练习">
      <MonthList />
    </StudentPage>
  );
}
