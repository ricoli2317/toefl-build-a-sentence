import { PracticeSession } from "@/components/PracticeSession";
import { StudentPage } from "@/components/student/StudentUI";

export default function PracticePage({ params }: { params: { setId: string } }) {
  return (
    <StudentPage title="Build a Sentence">
      <PracticeSession setId={params.setId} />
    </StudentPage>
  );
}
