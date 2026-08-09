import Link from "next/link";
import { ArrowRight, CalendarDays, type LucideIcon } from "lucide-react";

export type PracticeCatalogSet = {
  setId: string;
  setTitle: string;
  questionCount: number;
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
    <div className="grid gap-2.5">
      {sets.map((set) => (
        <article
          className="grid min-h-[86px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 rounded-2xl border border-student-border bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(23,32,51,0.025)] sm:px-5 md:grid-cols-[minmax(0,1fr)_5rem_6rem_18rem] md:gap-x-3 lg:grid-cols-[minmax(0,35fr)_minmax(5rem,12fr)_minmax(6rem,15fr)_minmax(20rem,38fr)] lg:gap-x-4"
          key={set.setId}
        >
          <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-3.5">
            <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-student-primary-soft text-student-primary">
              <CalendarDays aria-hidden="true" size={24} strokeWidth={1.9} />
            </span>
            <h2 className="min-w-0 text-lg font-bold leading-6 text-student-text sm:text-xl">
              {set.setTitle}
            </h2>
          </div>

          <p className="col-start-1 row-start-2 text-[14px] font-medium tabular-nums text-student-muted md:col-start-2 md:row-start-1 md:text-right md:text-[15px]">
            {set.questionCount}题
          </p>

          <div className="col-start-2 row-start-1 flex min-h-7 items-center justify-end md:col-start-3">
            {renderStatus?.(set) ?? <span aria-hidden="true" />}
          </div>

          <div className="col-start-2 row-start-2 flex min-w-0 items-center justify-end gap-2 md:col-start-4 md:row-start-1">
            {renderActions(set)}
          </div>
        </article>
      ))}
    </div>
  );
}

export function PracticeSetAction({
  href,
  icon: Icon,
  label
}: {
  href: string;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <Link
      className="inline-flex min-h-9 min-w-0 items-center justify-center gap-1.5 rounded-[10px] bg-student-primary-soft px-2 py-1.5 text-[12px] font-semibold text-student-primary transition hover:bg-student-primary-border sm:gap-2 sm:px-3.5 sm:text-sm"
      href={href}
    >
      <Icon aria-hidden="true" className="shrink-0" size={18} strokeWidth={1.9} />
      <span className="whitespace-nowrap">{label}</span>
    </Link>
  );
}
