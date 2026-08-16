import { TeacherWritingAssignmentForm } from "@/components/teacher/TeacherWritingAssignmentForm";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";

export default function NewTeacherWritingAssignmentPage() {
  return (
    <TeacherAppShell
      crumbs={[{ href: "/teacher/writing/assignments", label: "作业管理" }, { label: "布置作业" }]}
      subtitle="选择题目和学生，创建一项新的写作作业。"
      title="布置作业"
    >
      <TeacherWritingAssignmentForm />
    </TeacherAppShell>
  );
}
