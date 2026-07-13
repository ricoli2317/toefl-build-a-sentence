import { AppShell } from "@/components/AppShell";
import { WrongQuestionsPractice } from "@/components/WrongQuestions";

export default function StudentHistoryWrongQuestionsPracticePage({
  searchParams
}: {
  searchParams: { mode?: string };
}) {
  const mode = searchParams.mode === "random" ? "history-random" : "history-all";

  return (
    <AppShell
      brand="Build a Sentence"
      brandHref={null}
      eyebrow="Practice"
      title="Build a Sentence"
    >
      <WrongQuestionsPractice mode={mode} />
    </AppShell>
  );
}
