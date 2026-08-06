import { AppShell } from "@/components/AppShell";
import { PracticeResult } from "@/components/PracticeResult";
import { SignOutButton } from "@/components/SignOutButton";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentResultPage({
  params,
  searchParams
}: {
  params: { attemptId: string };
  searchParams: { setId?: string; source?: string };
}) {
  const source =
    searchParams.source === "practice-history-today" ||
    searchParams.source === "practice-history-history"
      ? searchParams.source
      : undefined;
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      brandHref={STUDENT_ROUTES.home}
      eyebrow="Result"
      title="Practice result"
    >
      <PracticeResult
        attemptId={params.attemptId}
        historySetId={searchParams.setId}
        source={source}
      />
    </AppShell>
  );
}
