import { TeacherWritingAssignmentForm } from "@/components/teacher/TeacherWritingAssignmentForm";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";

function firstSearchParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.trim() ?? "";
}

export default function NewTeacherWritingAssignmentPage({
  searchParams
}: {
  searchParams?: { studentId?: string | string[] };
}) {
  const studentId = firstSearchParam(searchParams?.studentId);

  return (
    <TeacherOnly>
    <TeacherAppShell
      crumbs={[{ href: "/teacher/writing/assignments", label: "作业管理" }, { label: "布置作业" }]}
      subtitle="选择题目和学生，创建一项新的写作作业。"
      title="布置作业"
    >
      <TeacherWritingAssignmentForm initialStudentId={studentId} />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
