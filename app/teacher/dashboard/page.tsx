import { AppShell } from "@/components/AppShell";
import Link from "next/link";
import { SignOutButton } from "@/components/SignOutButton";
import { TeacherDashboard } from "@/components/TeacherDashboard";

export default function TeacherDashboardPage() {
  return (
    <AppShell
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Link
            className="rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white hover:bg-ocean"
            href="/teacher/import"
          >
            Import CSV
          </Link>
          <SignOutButton />
        </div>
      }
      brand="Build a Sentence"
      eyebrow="Teacher"
      title="Teacher Dashboard"
    >
      <TeacherDashboard />
    </AppShell>
  );
}
