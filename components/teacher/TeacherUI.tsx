import Link from "next/link";
import { ArrowRight, type LucideIcon } from "lucide-react";
import clsx from "clsx";
import type { StudentPracticeIcon } from "@/components/icons/StudentPracticeIcons";

export type TeacherMetricTone = "primary" | "warning" | "reading";

export function TeacherCard({
  children,
  className
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <section className={clsx("teacher-card", className)}>{children}</section>;
}

export function TeacherSectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-lg font-bold text-student-text">{children}</h2>;
}

export function TeacherIconTile({
  icon: Icon,
  tone = "primary"
}: {
  icon: StudentPracticeIcon;
  tone?: TeacherMetricTone;
}) {
  return (
    <span
      className={clsx(
        "inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl",
        tone === "warning" && "bg-student-error-soft text-student-error",
        tone === "reading" && "bg-[#eef6ff] text-[#347fdc]",
        tone === "primary" && "bg-student-primary-soft text-student-primary"
      )}
    >
      <Icon aria-hidden="true" size={28} strokeWidth={1.9} />
    </span>
  );
}

export function TeacherMetricCard({
  icon,
  label,
  secondary,
  tone = "primary",
  value
}: {
  icon: StudentPracticeIcon;
  label: string;
  secondary?: React.ReactNode;
  tone?: TeacherMetricTone;
  value: React.ReactNode;
}) {
  return (
    <div className="teacher-card flex min-h-[108px] items-center gap-4 p-5">
      <TeacherIconTile icon={icon} tone={tone} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-student-muted">{label}</p>
        <p
          className={clsx(
            "mt-1 text-[2rem] font-bold leading-none tracking-tight",
            tone === "warning" && "text-student-error",
            tone === "reading" && "text-[#347fdc]",
            tone === "primary" && "text-student-text"
          )}
        >
          {value}
        </p>
        {secondary ? (
          <p className="mt-2 text-sm font-medium text-student-muted">{secondary}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Shared TPS feature entry card. Admin platform navigation and the Teacher
 * home work entries use the same card; the optional badge is a static label,
 * never a live count.
 */
export function TeacherFeatureCard({
  description,
  href,
  icon,
  metric,
  title
}: {
  description: string;
  href: string;
  icon: StudentPracticeIcon;
  metric?: React.ReactNode;
  title: string;
}) {
  return (
    <Link
      className="group flex min-h-[142px] items-center gap-5 rounded-2xl border border-student-primary-border bg-gradient-to-br from-white to-student-primary-soft/65 p-5 shadow-[0_2px_10px_rgba(88,65,170,0.05)] transition hover:-translate-y-px hover:shadow-[0_10px_28px_rgba(88,65,170,0.09)]"
      href={href}
    >
      <TeacherIconTile icon={icon} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-xl font-bold text-student-text">{title}</h3>
          {metric ? (
            <span className="rounded-full border border-student-primary-border bg-white/70 px-3 py-1 text-xs font-semibold text-student-primary">
              {metric}
            </span>
          ) : null}
        </div>
        <p className="mt-2 text-sm leading-6 text-student-muted">{description}</p>
      </div>
      <ArrowRight
        aria-hidden="true"
        className="shrink-0 text-student-primary transition group-hover:translate-x-1"
        size={21}
        strokeWidth={2}
      />
    </Link>
  );
}

export function TeacherSkeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        "block animate-pulse rounded-md bg-student-primary-soft",
        className
      )}
    />
  );
}

export function TeacherLoadingRegion({ label }: { label: string }) {
  return <span className="sr-only" role="status">{label}</span>;
}

export function TeacherDataError({ text }: { text: string }) {
  return <p className="teacher-error">{text}</p>;
}

export function TeacherAccuracyBar({ value }: { value: number }) {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div className="flex min-w-[180px] items-center gap-4">
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-student-primary-soft">
        <span
          className="block h-full rounded-full bg-gradient-to-r from-[#b69aff] to-student-primary"
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="w-11 text-right font-semibold tabular-nums text-student-text">{percent}%</span>
    </div>
  );
}

export function TeacherEmptyState({ text }: { text: string }) {
  return <p className="teacher-empty">{text}</p>;
}

export function TeacherTextLink({ children, href }: { children: React.ReactNode; href: string }) {
  return (
    <Link className="font-semibold text-student-primary hover:underline" href={href}>
      {children}
    </Link>
  );
}
