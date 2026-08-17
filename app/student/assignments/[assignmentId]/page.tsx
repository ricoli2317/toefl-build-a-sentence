import { StudentWritingAssignmentEntry } from "@/components/student/StudentWritingAssignments";

export default function StudentAssignmentEntryPage({
  params,
  searchParams
}: {
  params: { assignmentId: string };
  searchParams: { attempt?: string; new?: string };
}) {
  return (
    <StudentWritingAssignmentEntry
      assignmentId={params.assignmentId}
      attemptId={searchParams.attempt}
      forceNew={searchParams.new === "1"}
    />
  );
}
