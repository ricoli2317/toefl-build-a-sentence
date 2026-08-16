import { StudentDashboard } from "@/components/student/StudentDashboard";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentSetsPage() {
  return (
    <StudentPage compact title="学生首页">
      <StudentDashboard />
    </StudentPage>
  );
}
