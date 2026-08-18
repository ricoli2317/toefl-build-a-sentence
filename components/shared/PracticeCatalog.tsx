import Link from "next/link";
import { ArrowRight, CalendarDays, type LucideIcon } from "lucide-react";

export type PracticeCatalogSet = {
  setId: string;
  setTitle: string;
  questionCount: number;
  metadata?: React.ReactNode;
};

export function PracticeMonthCard({
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
  return (
    <Link className="student-card student-card-interactive group flex min-h-[88px] items-center gap-3.5 px-4 py-3 sm:p-3.5" href={href}>
      <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-student-primary-soft text-student-primary">
        <CalendarDays aria-hidden="true" size={23} strokeWidth={1.9} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-bold text-student-text">{month}</h2>
        <p className="mt-0.5 text-sm text-student-muted">{setCount}套 · {questionCount}题</p>
      </div>
      <ArrowRight aria-hidden="true" className="shrink-0 text-student-primary transition group-hover:translate-x-0.5" size={20} strokeWidth={1.9} />
    </Link>
  );
}

export function PracticeSetCatalogList({
  emptyState,
  renderActions,
  renderStatus,
  sets
}: {
  emptyState?: React.ReactNode;
  renderActions: (set: PracticeCatalogSet) => React.ReactNode;
  renderStatus?: (set: PracticeCatalogSet) => React.ReactNode;
  sets: PracticeCatalogSet[];
}) {
  if (sets.length === 0) return <>{emptyState ?? null}</>;

  return (
    <div className="grid gap-1.5">
      {sets.map((set) => (
        <article
          className="grid min-h-[64px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-2xl border border-student-border bg-white px-4 py-2.5 shadow-[0_1px_2px_rgba(23,32,51,0.025)] sm:px-5 md:grid-cols-[minmax(0,1fr)_5rem_auto] md:gap-x-5"
          key={set.setId}
        >
          <div className="col-span-2 row-start-1 flex min-w-0 items-center gap-3.5 md:col-span-1">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-student-primary-soft text-student-primary">
              <CalendarDays aria-hidden="true" size={20} strokeWidth={1.9} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="min-w-0 break-words text-base font-bold leading-5 text-student-text sm:text-[17px]">
                {set.setTitle}
              </h2>
              {set.metadata ? (
                <div className="mt-0.5 break-words text-xs leading-4 text-student-muted sm:text-[13px]">
                  {set.metadata}
                </div>
              ) : null}
            </div>
          </div>

          <p className="col-start-1 row-start-2 pl-[3.25rem] text-xs font-medium tabular-nums text-student-muted sm:text-[13px] md:col-start-2 md:row-start-1 md:p-0 md:text-center">
            {set.questionCount}题
          </p>

          <div className="col-span-2 row-start-3 flex min-w-0 flex-wrap items-center justify-end gap-2 md:col-span-1 md:col-start-3 md:row-start-1 md:flex-nowrap">
            <div className="flex min-h-6 shrink-0 items-center">
              {renderStatus?.(set) ?? null}
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
              {renderActions(set)}
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

export function PracticeSetAction({
  href,
  icon: Icon,
  label,
  primary = false
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  primary?: boolean;
}) {
  return (
    <Link
      className={primary
        ? "student-button-primary min-h-8 px-3 py-1 text-xs sm:text-[13px]"
        : "inline-flex min-h-8 min-w-0 items-center justify-center gap-1.5 rounded-[9px] bg-student-primary-soft px-2.5 py-1 text-xs font-semibold text-student-primary transition hover:bg-student-primary-border sm:gap-2 sm:px-3 sm:text-[13px]"}
      href={href}
    >
      <Icon aria-hidden="true" className="shrink-0" size={16} strokeWidth={1.9} />
      <span className="whitespace-nowrap">{label}</span>
    </Link>
  );
}
