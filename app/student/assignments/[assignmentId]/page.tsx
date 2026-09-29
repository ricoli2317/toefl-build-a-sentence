import { StudentWritingAssignmentEntry } from "@/components/student/StudentWritingAssignments";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function StudentAssignmentEntryPage({
  params,
  searchParams
}: {
  params: { assignmentId: string };
  searchParams: { attempt?: string; new?: string; returnTo?: string | string[] };
}) {
  return (
    <StudentWritingAssignmentEntry
      assignmentId={params.assignmentId}
      attemptId={searchParams.attempt}
      forceNew={searchParams.new === "1"}
      returnTo={safeStudentReturnTo(searchParams.returnTo)}
    />
  );
}
