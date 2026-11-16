import { GrammarCategoryAssignmentPractice } from "@/components/GrammarPractice";
import { StudentPage } from "@/components/student/StudentUI";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function StudentGrammarCategoryAssignmentPage({
  params,
  searchParams
}: {
  params: { assignmentId: string };
  searchParams: {
    new?: string;
    requestId?: string;
    returnTo?: string | string[];
    session?: string;
  };
}) {
  const forceNew = searchParams.new === "1";
  return (
    <StudentPage title="Build a Sentence">
      <GrammarCategoryAssignmentPractice
        assignmentId={params.assignmentId}
        initialSessionId={forceNew ? undefined : searchParams.session?.trim() || undefined}
        requestId={searchParams.requestId?.trim() || undefined}
        returnTo={safeStudentReturnTo(searchParams.returnTo)}
      />
    </StudentPage>
  );
}
