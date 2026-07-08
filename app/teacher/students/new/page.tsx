import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { TeacherCreateStudent } from "@/components/TeacherCreateStudent";
import { TeacherNavigation } from "@/components/TeacherDashboard";

export default function TeacherNewStudentPage() {
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      eyebrow="Teacher"
      title="Add Student"
    >
      <div className="grid gap-5">
        <TeacherNavigation
          backHref="/teacher/students"
          crumbs={[
            { label: "Teacher Home", href: "/teacher/dashboard" },
            { label: "Students", href: "/teacher/students" },
            { label: "Add Student" }
          ]}
        />
        <TeacherCreateStudent />
      </div>
    </AppShell>
  );
}
