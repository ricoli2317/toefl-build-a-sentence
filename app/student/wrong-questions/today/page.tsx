import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TodayWrongQuestions } from "@/components/WrongQuestions";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentTodayWrongQuestionsPage() {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      brandHref={STUDENT_ROUTES.home}
      eyebrow="Student"
      title="Today's Wrong Questions"
    >
      <TodayWrongQuestions />
    </AppShell>
  );
}
