import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { WrongQuestionsHome } from "@/components/WrongQuestions";

export default function StudentWrongQuestionsPage() {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Student"
      title="Wrong Questions"
    >
      <WrongQuestionsHome />
    </AppShell>
  );
}
