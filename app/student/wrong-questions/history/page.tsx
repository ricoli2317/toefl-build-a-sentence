import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { HistoryWrongQuestions } from "@/components/WrongQuestions";

export default function StudentHistoryWrongQuestionsPage() {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Student"
      title="History Wrong Questions"
    >
      <HistoryWrongQuestions />
    </AppShell>
  );
}
