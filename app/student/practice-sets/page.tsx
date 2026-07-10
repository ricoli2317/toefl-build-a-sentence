import { AppShell } from "@/components/AppShell";
import { MonthList } from "@/components/SetList";
import { SignOutButton } from "@/components/SignOutButton";

export default function StudentPracticeSetsPage() {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Student"
      title="Choose a month"
    >
      <MonthList />
    </AppShell>
  );
}
