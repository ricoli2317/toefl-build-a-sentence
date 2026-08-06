import { AppShell } from "@/components/AppShell";
import { PracticeHistorySetList } from "@/components/PracticeHistory";
import { SignOutButton } from "@/components/SignOutButton";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentPracticeHistorySetsPage({
  searchParams
}: {
  searchParams: { scope?: string };
}) {
  const scope = searchParams.scope === "today" ? "today" : "history";
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      brandHref={STUDENT_ROUTES.home}
      eyebrow="Student"
      title={scope === "today" ? "Today's Practice Sets" : "Practice Set History"}
    >
      <PracticeHistorySetList scope={scope} />
    </AppShell>
  );
}
