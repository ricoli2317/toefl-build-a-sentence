import Link from "next/link";
import { Plus } from "lucide-react";
import { TeacherWritingAssignmentList } from "@/components/teacher/TeacherWritingAssignmentList";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherOnly } from "@/components/RoleGate";

function firstSearchParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.trim() ?? "";
}

export default function TeacherWritingAssignmentsPage({
  searchParams
}: {
  searchParams?: { studentId?: string | string[] };
}) {
  const studentId = firstSearchParam(searchParams?.studentId);
  const newAssignmentHref = studentId
    ? `/teacher/writing/assignments/new?studentId=${encodeURIComponent(studentId)}`
    : "/teacher/writing/assignments/new";

  return (
    <TeacherOnly>
    <TeacherAppShell
      action={<Link className="teacher-button-primary" href={newAssignmentHref}><Plus aria-hidden="true" size={17} />布置作业</Link>}
      subtitle="布置写作任务并查看每名学生的完成状态。"
      title="作业管理"
    >
      <TeacherWritingAssignmentList studentId={studentId} />
    </TeacherAppShell>
    </TeacherOnly>
  );
}
