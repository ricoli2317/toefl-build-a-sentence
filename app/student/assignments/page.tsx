import { StudentWritingAssignmentList } from "@/components/student/StudentWritingAssignments";
import { StudentPage } from "@/components/student/StudentUI";

export default function StudentAssignmentsPage() {
  return (
    <StudentPage subtitle="查看教师布置的写作任务，继续草稿或查看已发布批改。" title="我的作业">
      <StudentWritingAssignmentList />
    </StudentPage>
  );
}
