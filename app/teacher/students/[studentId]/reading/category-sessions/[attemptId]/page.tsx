import { TeacherOnly } from "@/components/RoleGate";
import { TeacherStudentReadingAttemptDetail } from "@/components/teacher/TeacherStudentReadingAttemptDetail";
import { firstSearchParamValue, teacherReadingQuestionIndex } from "@/lib/teacherNavigation";

export default function TeacherCategorySessionPage({ params, searchParams }: {
  params: { attemptId: string; studentId: string }; searchParams?: { question?: string | string[]; returnTo?: string | string[] };
}) {
  return <TeacherOnly><TeacherStudentReadingAttemptDetail attemptId={params.attemptId} studentId={params.studentId}
    kind="category" questionIndex={teacherReadingQuestionIndex(searchParams?.question)} returnTo={firstSearchParamValue(searchParams?.returnTo)} /></TeacherOnly>;
}
