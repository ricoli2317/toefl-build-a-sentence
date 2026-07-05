import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TeacherStudentSetDetails } from "@/components/TeacherDashboard";

export default function TeacherStudentSetDetailsPage({
  params
}: {
  params: { setId: string; studentId: string };
}) {
  const setId = decodeURIComponent(params.setId);

  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Teacher"
      title="Set Attempts"
    >
      <TeacherStudentSetDetails setId={setId} studentId={params.studentId} />
    </AppShell>
  );
}
