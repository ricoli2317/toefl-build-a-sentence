import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { WrongQuestionsHome } from "@/components/WrongQuestions";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentWrongQuestionsPage() {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      brandHref={STUDENT_ROUTES.home}
      eyebrow="Student"
      title="Wrong Questions"
    >
      <WrongQuestionsHome />
    </AppShell>
  );
}
