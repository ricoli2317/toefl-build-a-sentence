import { TeacherWritingAssignmentsPageClient } from "@/components/teacher/TeacherWritingAssignmentsPageClient";
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

  return (
    <TeacherOnly>
      <TeacherWritingAssignmentsPageClient initialStudentId={studentId} />
    </TeacherOnly>
  );
}
