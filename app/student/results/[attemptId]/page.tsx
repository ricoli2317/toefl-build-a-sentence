import { AppShell } from "@/components/AppShell";
import { PracticeResult } from "@/components/PracticeResult";
import { SignOutButton } from "@/components/SignOutButton";

export default function StudentResultPage({ params }: { params: { attemptId: string } }) {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Result"
      title="Practice result"
    >
      <PracticeResult attemptId={params.attemptId} />
    </AppShell>
  );
}
