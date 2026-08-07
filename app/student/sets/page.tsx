import { StudentHome } from "@/components/SetList";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentSetsPage() {
  return (
    <StudentPage title="学生首页">
      <StudentHome />
    </StudentPage>
  );
}
