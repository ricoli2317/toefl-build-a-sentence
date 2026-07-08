import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TeacherQuestionBankSetViewer } from "@/components/TeacherQuestionBank";

export default function TeacherQuestionBankSetPage({
  params
}: {
  params: { monthKey: string; setId: string };
}) {
  const monthKey = decodeURIComponent(params.monthKey);
  const setId = decodeURIComponent(params.setId);

  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Teacher"
      title="Question Preview"
    >
      <TeacherQuestionBankSetViewer monthKey={monthKey} setId={setId} />
    </AppShell>
  );
}
