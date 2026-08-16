import Link from "next/link";
import { Plus } from "lucide-react";
import { TeacherWritingAssignmentList } from "@/components/teacher/TeacherWritingAssignmentList";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function TeacherWritingAssignmentsPage() {
  return (
    <TeacherAppShell
      action={<Link className="teacher-button-primary" href="/teacher/writing/assignments/new"><Plus aria-hidden="true" size={17} />布置作业</Link>}
      subtitle="布置写作任务并查看每名学生的完成状态。"
      title="作业管理"
    >
      <TeacherWritingAssignmentList />
    </TeacherAppShell>
  );
}
