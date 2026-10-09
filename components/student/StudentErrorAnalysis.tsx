"use client";

import type { ReactNode } from "react";

export type StudentErrorAnalysisTone = "orange" | "primary";

const ERROR_ANALYSIS_TONES = {
  orange: {
    action:
      "inline-flex min-h-8 items-center justify-center gap-2 rounded-[10px] border border-orange-300 bg-white px-3 py-1 text-xs font-semibold text-orange-500 transition hover:border-orange-500 hover:bg-orange-50",
    progress: "bg-orange-500",
    progressTrack: "bg-orange-100",
    rank: "bg-orange-50 text-orange-500"
  },
  primary: {
    action: "student-button-secondary min-h-8 px-3 py-1 text-xs",
    progress: "bg-student-primary",
    progressTrack: "bg-student-primary-soft",
    rank: "bg-student-primary-soft text-student-primary"
  }
} as const;

/** Shared BAS/RAP wrong-event ranking presentation; callers own practice entry. */
export function StudentErrorAnalysis<T extends { count: number; tag: string }>({
  items, title, subtitle, emptyText, renderAction, headerAction, footer,
  tone = "primary", minimumProgressPercent = 10, loading = false, error = false
}: {
  items: T[];
  title: ReactNode;
  subtitle: string;
  emptyText: string;
  renderAction: (item: T, className: string) => ReactNode;
  headerAction?: ReactNode;
  footer?: ReactNode;
  tone?: StudentErrorAnalysisTone;
  minimumProgressPercent?: number;
  loading?: boolean;
  error?: boolean;
}) {
  const visibleItems = items.slice(0, 5);
  const highestCount = visibleItems[0]?.count ?? 0;
  const toneStyles = ERROR_ANALYSIS_TONES[tone];
  return (
    <section className="rounded-2xl border border-student-primary-border bg-[linear-gradient(135deg,#fff_0%,#fbfaff_55%,#f7f5ff_100%)] p-5 shadow-[0_2px_12px_rgba(60,47,119,0.04)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-student-text">{title}</h2>
        {headerAction}
      </div>
      <h3 className="mt-4 text-sm font-bold text-student-text">{subtitle}</h3>
      {error ? (
        <p className="mt-3 text-sm text-student-muted" role="alert">统计加载失败，请稍后重试。</p>
      ) : loading ? (
        <p className="mt-3 text-sm text-student-muted">正在加载统计...</p>
      ) : visibleItems.length === 0 ? (
        <p className="mt-3 text-sm text-student-muted">{emptyText}</p>
      ) : (
        <ol className="mt-2 divide-y divide-student-border">
          {visibleItems.map((item, index) => (
            <li className="grid items-center gap-3 py-2.5 sm:grid-cols-[1.75rem_minmax(10rem,1fr)_minmax(12rem,2fr)_4rem_auto]" key={item.tag}>
              <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${toneStyles.rank}`}>
                {index + 1}
              </span>
              <span className="min-w-0 text-sm font-semibold text-student-text">{item.tag}</span>
              <span className={`h-1.5 overflow-hidden rounded-full ${toneStyles.progressTrack}`}>
                <span className={`block h-full rounded-full ${toneStyles.progress}`}
                  style={{ width: `${Math.max(minimumProgressPercent, highestCount > 0 ? (item.count / highestCount) * 100 : 0)}%` }} />
              </span>
              <span className="text-right text-xs font-semibold tabular-nums text-student-muted">{item.count} 题</span>
              {renderAction(item, toneStyles.action)}
            </li>
          ))}
        </ol>
      )}
      {footer}
    </section>
  );
}
