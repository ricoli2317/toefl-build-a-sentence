import { AppShell } from "@/components/AppShell";
import { GrammarQuestionsPractice } from "@/components/GrammarPractice";

export default function StudentGrammarQuestionsPracticePage({
  searchParams
}: {
  searchParams: { mode?: string; tag?: string };
}) {
  const mode = searchParams.mode === "random" ? "random" : "all";
  const tag = searchParams.tag?.trim() ?? "";

  return (
    <AppShell
      brand="Build a Sentence"
      brandHref={null}
      eyebrow="Practice"
      title="Build a Sentence"
    >
      <GrammarQuestionsPractice mode={mode} tag={tag} />
    </AppShell>
  );
}
