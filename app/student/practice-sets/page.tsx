import { AppShell } from "@/components/AppShell";
import { MonthList } from "@/components/SetList";
import { SignOutButton } from "@/components/SignOutButton";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentPracticeSetsPage() {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      brandHref={STUDENT_ROUTES.home}
      eyebrow="Student"
      title="Choose a month"
    >
      <MonthList />
    </AppShell>
  );
}
