import { AppShell } from "@/components/AppShell";
import { PracticeHistorySetAttempts } from "@/components/PracticeHistory";
import { SignOutButton } from "@/components/SignOutButton";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentPracticeHistorySetAttemptsPage({
  params,
  searchParams
}: {
  params: { setId: string };
  searchParams: { scope?: string };
}) {
  const setId = decodeURIComponent(params.setId);
  const scope = searchParams.scope === "today" ? "today" : "history";
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      brandHref={STUDENT_ROUTES.home}
      eyebrow="Student"
      title="Set Attempts"
    >
      <PracticeHistorySetAttempts scope={scope} setId={setId} />
    </AppShell>
  );
}
