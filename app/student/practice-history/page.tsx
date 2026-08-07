import { PracticeHistoryDashboard } from "@/components/PracticeHistory";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentPracticeHistoryPage() {
  return (
    <StudentPage title="练习历史">
      <PracticeHistoryDashboard />
    </StudentPage>
  );
}
