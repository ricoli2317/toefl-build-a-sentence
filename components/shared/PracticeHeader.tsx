"use client";

import { ArrowLeft } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

/** Extracted from ReadingPracticeHeader. Display only: callers own navigation
 * and clocks; no Reading state, RPC, heartbeat or timer effects live here. */
export const practiceShellStyle = { "--reading-header-height": "56px" } as CSSProperties;

export function PracticeTimer({ label = "Elapsed", value, testId }: {
  label?: string; value: string; testId?: string;
}) {
  return <div className="hidden items-baseline gap-2 whitespace-nowrap sm:flex">
    <span className="text-sm font-medium text-student-muted">{label}</span>
    <span className="font-mono text-base font-bold tabular-nums text-student-primary" data-testid={testId}>{value}</span>
  </div>;
}

export function PracticeHeader({ title, onBack, backDisabled = false, productName, progressLabel,
  progressTestId, compactTitle = false, actions }: {
  title: string; onBack?: () => void; backDisabled?: boolean; productName?: string;
  progressLabel?: string; progressTestId?: string; compactTitle?: boolean; actions?: ReactNode;
}) {
  return <header className="grid h-[var(--reading-header-height)] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 border-b border-student-border bg-white px-4 sm:px-7 lg:px-10" style={practiceShellStyle}>
    {onBack ? <button aria-label="Back" className="writing-header-back justify-self-start" disabled={backDisabled} onClick={onBack} type="button">
      <ArrowLeft aria-hidden="true" size={20} strokeWidth={2.2} />
      <span className="hidden sm:inline">Back</span>
    </button> : <span aria-hidden="true" />}
    <div className="min-w-0 justify-self-center text-center">
      {productName ? <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-student-muted">{productName}</p> : null}
      <p className={`${compactTitle ? "max-w-[42vw] sm:max-w-[58vw]" : "max-w-[58vw]"} truncate text-sm font-bold text-student-text sm:text-base`}>
        {title}{progressLabel ? <> <span aria-hidden="true" className="text-student-muted">·</span> <span data-testid={progressTestId}>{progressLabel}</span></> : null}
      </p>
    </div>
    <div className="flex items-center justify-self-end gap-2 sm:gap-3">{actions}</div>
  </header>;
}
