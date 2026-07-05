import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TeacherStudentDetails } from "@/components/TeacherDashboard";

export default function TeacherStudentDetailsPage({
  params
}: {
  params: { studentId: string };
}) {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Teacher"
      title="Student Details"
    >
      <TeacherStudentDetails studentId={params.studentId} />
    </AppShell>
  );
}
