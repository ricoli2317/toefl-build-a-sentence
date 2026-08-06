import { AppShell } from "@/components/AppShell";
import { PracticeHistoryErrorSummary } from "@/components/PracticeHistory";
import { SignOutButton } from "@/components/SignOutButton";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentPracticeHistoryErrorsPage({
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
      title={scope === "today" ? "今日错题汇总" : "历史错题汇总"}
    >
      <PracticeHistoryErrorSummary scope={scope} />
    </AppShell>
  );
}
