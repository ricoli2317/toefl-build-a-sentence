import { PracticeSession } from "@/components/PracticeSession";
import { StudentPage } from "@/components/student/StudentUI";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function PracticePage({
  params,
  searchParams
}: {
  params: { setId: string };
  searchParams: {
    assignmentId?: string | string[];
    returnTo?: string | string[];
  };
}) {
  const assignmentId = Array.isArray(searchParams.assignmentId)
    ? searchParams.assignmentId[0]
    : searchParams.assignmentId;

  return (
    <StudentPage title="Build a Sentence">
      <PracticeSession
        assignmentId={assignmentId?.trim() || null}
        requiresPracticeStart
        returnTo={safeStudentReturnTo(searchParams.returnTo)}
        setId={params.setId}
      />
    </StudentPage>
  );
}
