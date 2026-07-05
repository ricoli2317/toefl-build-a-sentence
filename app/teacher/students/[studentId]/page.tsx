import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TeacherStudentSummary } from "@/components/TeacherDashboard";

export default function TeacherStudentPage({ params }: { params: { studentId: string } }) {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Teacher"
      title="Student Summary"
    >
      <TeacherStudentSummary studentId={params.studentId} />
    </AppShell>
  );
}
