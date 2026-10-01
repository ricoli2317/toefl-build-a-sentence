import { TeacherOnly } from "@/components/RoleGate";
import { TeacherStudentReadingAttemptDetail } from "@/components/teacher/TeacherStudentReadingAttemptDetail";
import { firstSearchParamValue, teacherReadingQuestionIndex } from "@/lib/teacherNavigation";

export default function TeacherStudentReadingAttemptPage({
  params,
  searchParams
}: {
  params: { attemptId: string; studentId: string };
  searchParams?: { question?: string | string[]; returnTo?: string | string[] };
}) {
  return (
    <TeacherOnly>
      <TeacherStudentReadingAttemptDetail
        attemptId={params.attemptId}
        kind="attempt"
        questionIndex={teacherReadingQuestionIndex(searchParams?.question)}
        returnTo={firstSearchParamValue(searchParams?.returnTo)}
        studentId={params.studentId}
      />
    </TeacherOnly>
  );
}
