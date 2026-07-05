import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TeacherStudentsList } from "@/components/TeacherDashboard";

export default function TeacherStudentsPage() {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Teacher"
      title="Students"
    >
      <TeacherStudentsList />
    </AppShell>
  );
}
