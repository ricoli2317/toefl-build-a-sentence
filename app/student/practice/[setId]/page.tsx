import { PracticeSession } from "@/components/PracticeSession";
import { StudentPage } from "@/components/student/StudentUI";
import { safeStudentReturnTo } from "@/lib/studentNavigation";

export default function PracticePage({
  params,
  searchParams
}: {
  params: { setId: string };
  searchParams: { returnTo?: string | string[] };
}) {
  return (
    <StudentPage title="Build a Sentence">
      <PracticeSession
        returnTo={safeStudentReturnTo(searchParams.returnTo)}
        setId={params.setId}
      />
    </StudentPage>
  );
}
