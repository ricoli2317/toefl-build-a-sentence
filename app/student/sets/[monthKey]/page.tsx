import { AppShell } from "@/components/AppShell";
import { SetList } from "@/components/SetList";
import { SignOutButton } from "@/components/SignOutButton";
import { formatPracticeMonthLabel, STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentMonthSetsPage({ params }: { params: { monthKey: string } }) {
  const monthLabel = formatPracticeMonthLabel(params.monthKey);

  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      brandHref={STUDENT_ROUTES.home}
      eyebrow="Student"
      title={`${monthLabel} Practice Sets`}
    >
      <SetList monthKey={params.monthKey} monthLabel={monthLabel} />
    </AppShell>
  );
}
