import { TeacherOnly } from "@/components/RoleGate";
import { TeacherStudentReadingAttemptDetail } from "@/components/teacher/TeacherStudentReadingAttemptDetail";

export default function TeacherStudentReadingWrongbookAttemptPage({
  params
}: {
  params: { attemptId: string; studentId: string };
}) {
  return (
    <TeacherOnly>
      <TeacherStudentReadingAttemptDetail
        attemptId={params.attemptId}
        kind="wrongbook"
        studentId={params.studentId}
      />
    </TeacherOnly>
  );
}
