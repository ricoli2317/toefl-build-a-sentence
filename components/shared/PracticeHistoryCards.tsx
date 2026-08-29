import Link from "next/link";
import { ArrowRight, ClipboardList, Clock3 } from "lucide-react";
import { PracticeSetAction } from "@/components/shared/PracticeCatalog";

export type PracticeHistoryCompactItem = {
  attemptCount: number;
  bestAccuracy: string;
  href: string;
  latestAccuracy: string;
  latestCompleted: string;
  setId: string;
  setTitle: string;
};

export type PracticeSubmissionHistoryItem = {
  actions: React.ReactNode;
  badge?: React.ReactNode;
  details: React.ReactNode;
  id: string;
  submittedAt: string;
  title: string;
};

export function PracticeSubmissionHistoryHeader({
  description,
  eyebrow,
  title
}: {
  description: string;
  eyebrow: string;
  title: string;
}) {
  return (
    <header className="student-card">
      <p className="text-sm font-bold text-student-primary">{eyebrow}</p>
      <h2 className="mt-1 text-xl font-bold text-student-text">{title}</h2>
      <p className="mt-2 text-sm text-student-muted">{description}</p>
    </header>
  );
}

export function PracticeSubmissionHistoryList({
  emptyState,
  items
}: {
  emptyState: React.ReactNode;
  items: PracticeSubmissionHistoryItem[];
}) {
  if (items.length === 0) return <>{emptyState}</>;
  return (
    <div className="grid gap-3">
      {items.map((item) => (
        <article className="student-card flex flex-wrap items-center justify-between gap-4" key={item.id}>
          <div className="flex min-w-0 items-start gap-3">
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-student-primary-soft text-student-primary">
              <Clock3 aria-hidden="true" size={22} />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-bold text-student-text">{item.title}</h2>
                {item.badge}
              </div>
              <p className="mt-1 text-sm text-student-muted">{item.submittedAt}</p>
              <div className="mt-1">{item.details}</div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">{item.actions}</div>
        </article>
      ))}
    </div>
  );
}

export function PracticeHistoryCompactList({
  emptyState,
  items,
  title = "练习记录"
}: {
  emptyState?: React.ReactNode;
  items: PracticeHistoryCompactItem[];
  title?: string;
}) {
  return (
    <section className="rounded-2xl border border-student-border bg-white p-4 shadow-[0_2px_12px_rgba(60,47,119,0.045)] sm:p-5">
      <h2 className="text-xl font-bold text-student-text">{title}</h2>

      {items.length === 0 ? (
        <div className="mt-4">{emptyState ?? null}</div>
      ) : (
        <div className="mt-3">
          <div className="hidden min-h-8 grid-cols-[minmax(0,28fr)_minmax(0,18fr)_minmax(0,16fr)_minmax(0,16fr)_minmax(0,11fr)_minmax(7.5rem,11fr)] items-center gap-x-3 px-4 text-xs font-semibold text-student-muted lg:grid">
            <span>套题</span>
            <span>最近完成</span>
            <span>最近正确率</span>
            <span>最佳正确率</span>
            <span className="text-center">练习次数</span>
            <span className="text-center">操作</span>
          </div>

          <div className="grid gap-1.5">
            {items.map((item) => (
              <article
                className="group grid min-h-[68px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-xl border border-student-border bg-white px-4 py-2.5 transition hover:border-student-primary-border hover:bg-student-primary-soft/45 md:grid-cols-[minmax(0,1.6fr)_minmax(8rem,1fr)_minmax(5.5rem,.7fr)_minmax(4.5rem,.55fr)_minmax(7.5rem,.8fr)] md:gap-x-4 lg:grid-cols-[minmax(0,28fr)_minmax(0,18fr)_minmax(0,16fr)_minmax(0,16fr)_minmax(0,11fr)_minmax(7.5rem,11fr)] lg:gap-x-3"
                key={item.setId}
              >
                <div className="col-start-1 row-start-1 min-w-0 md:row-auto">
                  <p className="truncate text-[15px] font-semibold leading-5 text-student-text sm:text-base">{item.setTitle}</p>
                  <p className="mt-0.5 truncate text-xs leading-4 text-student-muted sm:text-[13px]">{item.setId}</p>
                </div>

                <p className="col-start-1 row-start-2 truncate text-xs text-student-muted md:col-start-2 md:row-start-1 md:text-sm">
                  {item.latestCompleted}
                </p>

                <p className="col-start-2 row-start-2 text-sm font-semibold tabular-nums text-student-primary md:col-start-3 md:row-start-1 md:text-[15px]">
                  {item.latestAccuracy}
                </p>

                <p className="hidden truncate text-sm font-medium tabular-nums text-student-muted lg:col-start-4 lg:block">
                  {item.bestAccuracy}
                </p>

                <div className="col-start-1 row-start-3 flex justify-start md:col-start-4 md:row-start-1 md:justify-center lg:col-start-5">
                  <span className="inline-flex min-h-9 items-center justify-center rounded-full bg-student-primary-soft px-4 py-1.5 text-sm font-semibold tabular-nums text-student-primary">
                    {item.attemptCount}次
                  </span>
                </div>

                <div className="col-start-2 row-start-3 flex justify-end md:col-start-5 md:row-start-1 md:justify-center lg:col-start-6">
                  <PracticeSetAction href={item.href} icon={ClipboardList} label="查看详情" />
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function PracticeHistorySetCard({
  attemptCount,
  children,
  href,
  primaryMetric,
  setId,
  setTitle
}: {
  attemptCount: number;
  children?: React.ReactNode;
  href: string;
  primaryMetric: React.ReactNode;
  setId: string;
  setTitle: string;
}) {
  return (
    <Link className="student-card student-card-interactive group" href={href}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold text-student-text">{setTitle}</h2>
          <p className="mt-1 truncate text-sm text-student-muted">{setId}</p>
        </div>
        <span className="student-chip shrink-0">练习 {attemptCount} 次</span>
      </div>
      {children}
      <div className="mt-5 flex items-center justify-between gap-3 text-sm">
        <p className="font-semibold text-student-primary">{primaryMetric}</p>
        <ArrowRight aria-hidden="true" className="text-student-primary transition group-hover:translate-x-0.5" size={18} />
      </div>
    </Link>
  );
}
