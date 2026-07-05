import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TeacherNavigation } from "@/components/TeacherDashboard";
import { TeacherImportQuestions } from "@/components/TeacherImportQuestions";

export default function TeacherImportPage() {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Teacher"
      title="Import question CSV"
    >
      <div className="grid gap-5">
        <TeacherNavigation
          backHref="/teacher/dashboard"
          crumbs={[
            { label: "Teacher Home", href: "/teacher/dashboard" },
            { label: "Import CSV" }
          ]}
        />
        <TeacherImportQuestions />
      </div>
    </AppShell>
  );
}
