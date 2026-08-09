import { redirect } from "next/navigation";

export default function TeacherStudentDetailsPage({
  params
}: {
  params: { studentId: string };
}) {
  redirect(`/teacher/students/${encodeURIComponent(params.studentId)}`);
}
