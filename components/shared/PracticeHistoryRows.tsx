import type { ReactNode } from "react";
import { TeacherAccuracyBar, TeacherCard } from "@/components/teacher/TeacherUI";

/** The existing practice-history shell and row geometry, shared without changing
 * its markup, spacing or the role-specific content/actions placed inside it. */
export function PracticeHistoryRows({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <TeacherCard className={`overflow-hidden p-0${className ? ` ${className}` : ""}`}>
    <div className="divide-y divide-student-border px-5">{children}</div>
  </TeacherCard>;
}

export function PracticeHistoryRow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-3 py-3${className ? ` ${className}` : ""}`}>{children}</div>;
}

export function PracticeHistoryAccuracy({ value, label }: { value: number | null; label: string }) {
  const display = value === null ? "—" : `${Math.max(0, Math.min(100, Math.round(value * 100)))}%`;
  return <div role="img" aria-label={`${label} ${display}`} className="text-sm">
    {value === null ? <div className="flex min-w-[180px] items-center gap-4">
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-student-primary-soft" />
      <span className="w-11 text-right font-semibold tabular-nums text-student-text">—</span>
    </div> : <TeacherAccuracyBar value={value} />}
  </div>;
}

export function PracticeHistoryBadge({ children, reading = false }: { children: ReactNode; reading?: boolean }) {
  return <span className={reading
    ? "shrink-0 rounded-full border border-[#cfe3f8] bg-[#eef6ff] px-2 py-0.5 text-xs font-semibold text-[#347fdc]"
    : "shrink-0 rounded-full border border-student-primary-border bg-student-primary-soft px-2 py-0.5 text-xs font-semibold text-student-primary"}>{children}</span>;
}
