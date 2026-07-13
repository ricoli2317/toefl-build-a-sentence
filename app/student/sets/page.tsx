import { AppShell } from "@/components/AppShell";
import { StudentHome } from "@/components/SetList";
import { SignOutButton } from "@/components/SignOutButton";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentSetsPage() {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      brandHref={STUDENT_ROUTES.home}
      eyebrow="Student"
      title="Student Home"
    >
      <StudentHome />
    </AppShell>
  );
}
