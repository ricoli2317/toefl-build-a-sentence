import { AppShell } from "@/components/AppShell";
import { SetList } from "@/components/SetList";
import { SignOutButton } from "@/components/SignOutButton";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

export default function StudentPracticeMonthSetsPage({
  params
}: {
  params: { monthKey: string };
}) {
  const monthLabel = formatMonthLabel(params.monthKey);

  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Student"
      title={`${monthLabel} Practice Sets`}
    >
      <SetList monthKey={params.monthKey} monthLabel={monthLabel} />
    </AppShell>
  );
}

function formatMonthLabel(monthKey: string) {
  const month = Number(monthKey.slice(4, 6));
  if (!Number.isFinite(month) || month < 1 || month > 12) return monthKey;
  return MONTH_NAMES[month - 1];
}
