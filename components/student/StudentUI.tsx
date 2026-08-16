import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  CircleAlert,
  ClipboardX,
  Info,
  Target,
  X,
  type LucideIcon
} from "lucide-react";
import clsx from "clsx";
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";
import { PracticeMonthCard } from "@/components/shared/PracticeCatalog";

export function StudentPage({
  children,
  compact = false,
  subtitle,
  title
}: {
  children: React.ReactNode;
  compact?: boolean;
  subtitle?: string;
  title: string;
}) {
  return (
    <section className={clsx("student-page", compact && "student-dashboard-page")}>
      <header>
        <h1 className="student-page-title">{title}</h1>
        {subtitle ? <p className="mt-2 max-w-2xl text-sm leading-6 text-student-muted">{subtitle}</p> : null}
      </header>
      {children}
    </section>
  );
}

export function StudentNavigation({
  backHref,
  crumbs,
  showBack = true
}: {
  backHref: string;
  crumbs: Array<{ href?: string; label: string }>;
  showBack?: boolean;
}) {
  return (
    <nav aria-label="页面路径" className="flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13px]">
      {showBack ? (
        <Link className="student-button-secondary min-h-8 px-3 py-1" href={backHref}>
          <ArrowLeft aria-hidden="true" size={15} />
          {STUDENT_UI_TEXT.back}
        </Link>
      ) : null}
      {showBack ? <span aria-hidden="true" className="h-4 w-px bg-student-border" /> : null}
      <ol className="flex min-w-0 flex-wrap items-center gap-1.5">
        {crumbs.map((crumb, index) => (
          <li className="flex min-w-0 items-center gap-1.5" key={`${crumb.label}-${index}`}>
            {index > 0 ? <span aria-hidden="true" className="text-student-muted">/</span> : null}
            {crumb.href ? (
              <Link className="font-semibold text-student-primary hover:underline" href={crumb.href}>
                {crumb.label}
              </Link>
            ) : (
              <span className="font-semibold text-student-text">{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function StudentFeatureCard({
  description,
  href,
  icon: Icon,
  meta,
  tone = "primary",
  title
}: {
  description: string;
  href: string;
  icon: LucideIcon;
  meta?: React.ReactNode;
  tone?: "primary" | "error";
  title: string;
}) {
  const error = tone === "error";
  return (
    <Link
      className={clsx(
        "student-card student-card-interactive group flex min-h-[168px] flex-col border-t-2 p-5 sm:p-5",
        error ? "border-t-student-error-border" : "border-t-student-primary-border"
      )}
      href={href}
    >
      <div className="flex items-start gap-4">
        <StudentIconTile icon={Icon} tone={tone} />
      </div>
      <div className="mt-4">
        <h2 className="text-lg font-bold text-student-text">{title}</h2>
        <p className="mt-1 text-sm leading-5 text-student-muted">{description}</p>
      </div>
      <div className="mt-auto flex items-end justify-between gap-3 pt-3">
        {meta ? (
          <span className={error ? "student-chip-error" : "student-chip"}>{meta}</span>
        ) : (
          <span />
        )}
        <ArrowRight
          aria-hidden="true"
          className={clsx("shrink-0 transition group-hover:translate-x-0.5", error ? "text-student-error" : "text-student-primary")}
          size={18}
        />
      </div>
    </Link>
  );
}

export function StudentMonthCard({
  href,
  month,
  questionCount,
  setCount
}: {
  href: string;
  month: string;
  questionCount: number;
  setCount: number;
}) {
  return <PracticeMonthCard href={href} month={month} questionCount={questionCount} setCount={setCount} />;
}

export function StudentGrammarCard({ href, label, questionCount }: { href: string; label: string; questionCount: number }) {
  return (
    <Link className="student-card student-card-interactive group grid min-h-[58px] grid-cols-[1.5rem_minmax(0,1fr)_4rem_1.25rem] items-center gap-3 rounded-xl px-4 py-2.5 sm:p-2.5 sm:px-4" href={href}>
      <BookOpen aria-hidden="true" className="shrink-0 text-student-primary" size={22} strokeWidth={1.9} />
      <h2 className="min-w-0 font-semibold leading-5 text-student-text">{label}</h2>
      <span className="text-right text-sm font-semibold tabular-nums text-student-muted">{questionCount}题</span>
      <ArrowRight aria-hidden="true" className="shrink-0 text-student-primary transition group-hover:translate-x-0.5" size={19} strokeWidth={1.9} />
    </Link>
  );
}

export function StudentStatCard({
  href,
  icon: Icon,
  label,
  tone = "primary",
  value
}: {
  href?: string;
  icon?: LucideIcon;
  label: string;
  tone?: "primary" | "error";
  value: string;
}) {
  const error = tone === "error";
  const content = (
    <div className="flex min-h-[54px] items-center gap-3.5">
      {Icon ? <StudentIconTile icon={Icon} tone={tone} /> : null}
      <div className="min-w-0">
        <p className={clsx("text-2xl font-bold leading-none tracking-tight", error ? "text-student-error" : "text-student-primary")}>{value}</p>
        <p className="mt-1.5 text-xs font-medium text-student-muted">{label}</p>
      </div>
    </div>
  );
  return href ? (
    <Link className="student-card student-card-interactive p-3.5 sm:p-3.5" href={href}>{content}</Link>
  ) : (
    <div className="student-card p-3.5 sm:p-3.5">{content}</div>
  );
}

export function StudentIconTile({
  icon: Icon,
  tone = "primary"
}: {
  icon: LucideIcon;
  tone?: "primary" | "error";
}) {
  const error = tone === "error";
  return (
    <span
      className={clsx(
        "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
        error ? "bg-student-error-soft text-student-error" : "bg-student-primary-soft text-student-primary"
      )}
    >
      <Icon aria-hidden="true" size={23} strokeWidth={1.9} />
    </span>
  );
}

export function StudentSectionHeader({
  action,
  icon: Icon,
  title
}: {
  action?: React.ReactNode;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        <Icon aria-hidden="true" className="text-student-primary" size={21} strokeWidth={1.9} />
        <h2 className="text-lg font-bold text-student-text">{title}</h2>
      </div>
      {action}
    </div>
  );
}

export function StudentInfoStrip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-2.5 rounded-xl bg-student-primary-soft px-3.5 py-2 text-xs leading-5 text-student-muted">
      <Info aria-hidden="true" className="shrink-0 text-student-primary" size={17} strokeWidth={1.9} />
      <p>{children}</p>
    </div>
  );
}

export function StudentWrongQuestionCard({
  description,
  href,
  icon: Icon,
  metricLabel,
  metricUnit = "题",
  metricValue,
  title
}: {
  description: string;
  href: string;
  icon: LucideIcon;
  metricLabel: string;
  metricUnit?: string;
  metricValue: React.ReactNode;
  title: string;
}) {
  return (
    <Link
      className="student-card group relative flex flex-col border-student-error-border p-4 transition hover:-translate-y-px hover:shadow-[0_8px_24px_rgba(23,32,51,0.055)] sm:p-4"
      href={href}
    >
      <span className="relative inline-flex h-14 w-14 items-center justify-center text-student-primary">
        <Icon aria-hidden="true" size={45} strokeWidth={1.8} />
        <span className="absolute bottom-0 right-0 inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-student-error text-white shadow-[0_0_0_2px_white]">
          <X aria-hidden="true" size={13} strokeWidth={3} />
        </span>
      </span>
      <div className="mt-2 min-w-0 pr-10">
        <h2 className="text-[25px] font-bold leading-8 tracking-[-0.018em] text-student-text">{title}</h2>
        <p className="mt-1 text-base leading-6 text-student-muted">{description}</p>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-[15px] font-medium text-student-muted">{metricLabel}</span>
        <span className="text-[2.5rem] font-bold leading-none tracking-tight text-student-error">{metricValue}</span>
        <span className="text-[15px] font-medium text-student-muted">{metricUnit}</span>
      </div>
      <ArrowRight aria-hidden="true" className="absolute bottom-[1.35rem] right-4 shrink-0 text-student-text transition group-hover:translate-x-0.5" size={21} strokeWidth={1.9} />
    </Link>
  );
}

export function StudentErrorGrammarPanel({
  items,
  limit,
  sectionMarker = false
}: {
  items: Array<{ count: number; tag: string }>;
  limit?: number;
  sectionMarker?: boolean;
}) {
  const visibleItems = typeof limit === "number" ? items.slice(0, limit) : items;
  const highestCount = visibleItems[0]?.count ?? 0;
  const action = (
    <Link className="student-button-primary min-h-9 px-3.5 py-1.5" href="/student/grammar-practice">
      按语法分类练习
      <ArrowRight aria-hidden="true" size={15} />
    </Link>
  );

  return (
    <section className="student-card p-4 sm:p-5">
      {sectionMarker ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="h-5 w-1 rounded-full bg-student-primary" />
            <h2 className="text-[19px] font-bold leading-6 text-student-text">高频错误语法点</h2>
          </div>
          {action}
        </div>
      ) : (
        <StudentSectionHeader action={action} icon={Target} title="高频错误语法点" />
      )}
      {visibleItems.length === 0 ? (
        <p className="pt-4 text-sm text-student-muted">暂无高频错误语法点。</p>
      ) : (
        <ol className="mt-3 border-t border-student-border">
          {visibleItems.map((item, index) => (
            <li
              className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1.5 border-b border-student-border py-2 last:border-b-0 sm:grid-cols-[1.75rem_minmax(12rem,1fr)_minmax(10rem,2fr)]"
              key={item.tag}
            >
              <span
                className={clsx(
                  "inline-flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold",
                  index === 0
                    ? "bg-student-error text-white"
                    : "bg-student-primary-soft text-student-primary ring-1 ring-student-primary-border"
                )}
              >
                {index + 1}
              </span>
              <span className="min-w-0 text-sm font-semibold leading-5 text-student-text">{item.tag}</span>
              <div className="col-start-2 h-1.5 overflow-hidden rounded-full bg-student-error-soft sm:col-start-3">
                <div
                  className="h-full rounded-full bg-student-error"
                  style={{
                    width: `${Math.max(10, highestCount > 0 ? (item.count / highestCount) * 100 : 0)}%`
                  }}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function StudentEmptyState({ text, tone = "neutral" }: { text: string; tone?: "neutral" | "error" }) {
  return (
    <div className={tone === "error" ? "student-error-state" : "student-empty"}>
      {tone === "error" ? <CircleAlert aria-hidden="true" className="mb-3" size={22} /> : null}
      <p>{text}</p>
    </div>
  );
}

export function StudentLoadingState({ text }: { text: string }) {
  return <p className="student-loading">{text}</p>;
}

export function StudentErrorState({ text }: { text: string }) {
  return <p className="student-error-state">{text}</p>;
}

export const studentIcons = {
  wrongQuestions: ClipboardX,
  practiceSets: CalendarDays,
  grammarPractice: BookOpen
} as const;
