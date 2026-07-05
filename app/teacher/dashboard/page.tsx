import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TeacherDashboard } from "@/components/TeacherDashboard";

export default function TeacherDashboardPage() {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Teacher"
      title="Teacher Dashboard"
    >
      <TeacherDashboard />
    </AppShell>
  );
}
