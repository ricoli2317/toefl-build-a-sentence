import { TeacherOnly } from "@/components/RoleGate";
import { TeacherStudentReadingAttemptDetail } from "@/components/teacher/TeacherStudentReadingAttemptDetail";
import { firstSearchParamValue } from "@/lib/teacherNavigation";

export default function TeacherStudentReadingFullSetAttemptPage({
  params,
  searchParams
}: {
  params: { attemptId: string; studentId: string };
  searchParams?: { returnTo?: string | string[] };
}) {
  return (
    <TeacherOnly>
      <TeacherStudentReadingAttemptDetail
        attemptId={params.attemptId}
        kind="full-set"
        returnTo={firstSearchParamValue(searchParams?.returnTo)}
        studentId={params.studentId}
      />
    </TeacherOnly>
  );
}
