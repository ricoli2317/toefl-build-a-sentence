import { AppShell } from "@/components/AppShell";
import { PracticeSession } from "@/components/PracticeSession";
import { SignOutButton } from "@/components/SignOutButton";

export default function PracticePage({ params }: { params: { setId: string } }) {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      brandHref={null}
      eyebrow="Practice"
      title="Build a Sentence"
    >
      <PracticeSession setId={params.setId} />
    </AppShell>
  );
}
