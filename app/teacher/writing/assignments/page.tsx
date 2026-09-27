import { TeacherWritingAssignmentsPageClient } from "@/components/teacher/TeacherWritingAssignmentsPageClient";
import { TeacherOnly } from "@/components/RoleGate";

function firstSearchParam(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.trim() ?? "";
}

export default function TeacherWritingAssignmentsPage({
  searchParams
}: {
  searchParams?: { studentId?: string | string[]; view?: string | string[]; classId?: string | string[] };
}) {
  const studentId = firstSearchParam(searchParams?.studentId);
  const classId = firstSearchParam(searchParams?.classId);
  const view = firstSearchParam(searchParams?.view) === "class" ? "class" : "students";

  return (
    <TeacherOnly>
      <TeacherWritingAssignmentsPageClient
        initialClassId={view === "class" ? classId : ""}
        initialStudentId={studentId}
        initialView={view}
      />
    </TeacherOnly>
  );
}
