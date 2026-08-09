import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import clsx from "clsx";

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
  icon: LucideIcon;
  tone?: "primary" | "warning";
}) {
  return (
    <span
      className={clsx(
        "inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl",
        tone === "warning"
          ? "bg-student-error-soft text-student-error"
          : "bg-student-primary-soft text-student-primary"
      )}
    >
      <Icon aria-hidden="true" size={28} strokeWidth={1.9} />
    </span>
  );
}

export function TeacherMetricCard({
  icon,
  label,
  tone = "primary",
  value
}: {
  icon: LucideIcon;
  label: string;
  tone?: "primary" | "warning";
  value: string;
}) {
  return (
    <div className="teacher-card flex min-h-[108px] items-center gap-4 p-5">
      <TeacherIconTile icon={icon} tone={tone} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-student-muted">{label}</p>
        <p
          className={clsx(
            "mt-1 text-[2rem] font-bold leading-none tracking-tight",
            tone === "warning" ? "text-student-error" : "text-student-text"
          )}
        >
          {value}
        </p>
      </div>
    </div>
  );
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
