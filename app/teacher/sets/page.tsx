import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TeacherSetsList } from "@/components/TeacherDashboard";

export default function TeacherSetsPage() {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Teacher"
      title="Practice Sets"
    >
      <TeacherSetsList />
    </AppShell>
  );
}
