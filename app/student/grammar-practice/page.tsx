import { AppShell } from "@/components/AppShell";
import {
  GrammarPracticeHome,
  GrammarPracticeModeSelect
} from "@/components/GrammarPractice";
import { SignOutButton } from "@/components/SignOutButton";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentGrammarPracticePage({
  searchParams
}: {
  searchParams: { tag?: string };
}) {
  const tag = searchParams.tag?.trim() ?? "";
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      brandHref={STUDENT_ROUTES.home}
      eyebrow="Student"
      title="Grammar Practice"
    >
      {tag ? <GrammarPracticeModeSelect tag={tag} /> : <GrammarPracticeHome />}
    </AppShell>
  );
}
