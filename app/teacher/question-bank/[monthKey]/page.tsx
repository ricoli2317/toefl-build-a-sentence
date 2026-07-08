import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TeacherQuestionBankSets } from "@/components/TeacherQuestionBank";

export default function TeacherQuestionBankMonthPage({
  params
}: {
  params: { monthKey: string };
}) {
  const monthKey = decodeURIComponent(params.monthKey);

  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Teacher"
      title="Practice Sets"
    >
      <TeacherQuestionBankSets monthKey={monthKey} />
    </AppShell>
  );
}
