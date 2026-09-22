import { TeacherOnly } from "@/components/RoleGate";
import { TeacherStudentReadingAttemptDetail } from "@/components/teacher/TeacherStudentReadingAttemptDetail";

export default function TeacherStudentReadingFullSetAttemptPage({
  params
}: {
  params: { attemptId: string; studentId: string };
}) {
  return (
    <TeacherOnly>
      <TeacherStudentReadingAttemptDetail
        attemptId={params.attemptId}
        kind="full-set"
        studentId={params.studentId}
      />
    </TeacherOnly>
  );
}
