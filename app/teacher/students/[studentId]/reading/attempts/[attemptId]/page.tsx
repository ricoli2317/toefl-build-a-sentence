import { TeacherOnly } from "@/components/RoleGate";
import { TeacherStudentReadingAttemptDetail } from "@/components/teacher/TeacherStudentReadingAttemptDetail";

export default function TeacherStudentReadingAttemptPage({
  params
}: {
  params: { attemptId: string; studentId: string };
}) {
  return (
    <TeacherOnly>
      <TeacherStudentReadingAttemptDetail
        attemptId={params.attemptId}
        kind="attempt"
        studentId={params.studentId}
      />
    </TeacherOnly>
  );
}
