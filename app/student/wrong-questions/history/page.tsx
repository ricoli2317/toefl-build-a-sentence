import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { HistoryWrongQuestions } from "@/components/WrongQuestions";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentHistoryWrongQuestionsPage() {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      brandHref={STUDENT_ROUTES.home}
      eyebrow="Student"
      title="History Wrong Questions"
    >
      <HistoryWrongQuestions />
    </AppShell>
  );
}
