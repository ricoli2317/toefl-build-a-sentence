import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TeacherStudentQuestionDetail } from "@/components/TeacherDashboard";

export default function TeacherStudentQuestionDetailPage({
  params
}: {
  params: { attemptAnswerId: string; studentId: string };
}) {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Teacher"
      title="Question Detail"
    >
      <TeacherStudentQuestionDetail attemptAnswerId={params.attemptAnswerId} />
    </AppShell>
  );
}
