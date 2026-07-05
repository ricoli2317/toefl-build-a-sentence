import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TeacherSetQuestionDetail } from "@/components/TeacherDashboard";

export default function TeacherSetQuestionPage({
  params
}: {
  params: { questionId: string; setId: string };
}) {
  const setId = decodeURIComponent(params.setId);
  const questionId = decodeURIComponent(params.questionId);

  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Teacher"
      title="Question Statistics"
    >
      <TeacherSetQuestionDetail questionId={questionId} setId={setId} />
    </AppShell>
  );
}
