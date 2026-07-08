import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TeacherQuestionBankMonths } from "@/components/TeacherQuestionBank";

export default function TeacherQuestionBankPage() {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Teacher"
      title="All Practice Sets"
    >
      <TeacherQuestionBankMonths />
    </AppShell>
  );
}
