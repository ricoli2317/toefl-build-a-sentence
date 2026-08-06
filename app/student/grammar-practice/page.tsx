import { AppShell } from "@/components/AppShell";
import { SignOutButton } from "@/components/SignOutButton";
import { StudentNavigation } from "@/components/SetList";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export default function StudentGrammarPracticePage({
  searchParams
}: {
  searchParams: { tag?: string };
}) {
  const tag = searchParams.tag?.trim() ?? "";
  return (
    <AppShell
      action={<SignOutButton />}
      brand="Build a Sentence"
      brandHref={STUDENT_ROUTES.home}
      eyebrow="Student"
      title="Grammar Practice"
    >
      <div className="grid gap-5">
        <StudentNavigation
          backHref={STUDENT_ROUTES.home}
          crumbs={[
            { label: "Student Home", href: STUDENT_ROUTES.home },
            { label: "Grammar Practice" }
          ]}
        />
        <section className="rounded-lg border border-line bg-white p-5 shadow-sm">
          <p className="text-sm font-semibold text-ocean">按语法分类练习</p>
          <h2 className="mt-1 text-2xl font-bold">功能开发中</h2>
          {tag ? (
            <p className="mt-4 text-ink/70">
              已选择语法标签：<span className="font-semibold text-ink">{tag}</span>
            </p>
          ) : (
            <p className="mt-4 text-ink/70">语法分类练习将在后续阶段开放。</p>
          )}
        </section>
      </div>
    </AppShell>
  );
}
