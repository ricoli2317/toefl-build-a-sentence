import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TodayWrongQuestions } from "@/components/WrongQuestions";

export default function StudentTodayWrongQuestionsPage() {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Student"
      title="Today's Wrong Questions"
    >
      <TodayWrongQuestions />
    </AppShell>
  );
}
