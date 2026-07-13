import { AppShell } from "@/components/AppShell";
import { PracticeResult } from "@/components/PracticeResult";
import { SignOutButton } from "@/components/SignOutButton";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentResultPage({ params }: { params: { attemptId: string } }) {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      brandHref={STUDENT_ROUTES.home}
      eyebrow="Result"
      title="Practice result"
    >
      <PracticeResult attemptId={params.attemptId} />
    </AppShell>
  );
}
