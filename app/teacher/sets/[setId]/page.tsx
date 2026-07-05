import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TeacherSetSummary } from "@/components/TeacherDashboard";

export default function TeacherSetPage({ params }: { params: { setId: string } }) {
  const setId = decodeURIComponent(params.setId);

  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Teacher"
      title="Set Statistics"
    >
      <TeacherSetSummary setId={setId} />
    </AppShell>
  );
}
