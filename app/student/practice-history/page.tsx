import { AppShell } from "@/components/AppShell";
import { PracticeHistoryDashboard } from "@/components/PracticeHistory";
import { SignOutButton } from "@/components/SignOutButton";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentPracticeHistoryPage({
  searchParams
}: {
  searchParams: { tab?: string };
}) {
  const scope = searchParams.tab === "history" ? "history" : "today";
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      brandHref={STUDENT_ROUTES.home}
      eyebrow="Student"
      title="Practice History"
    >
      <PracticeHistoryDashboard scope={scope} />
    </AppShell>
  );
}
