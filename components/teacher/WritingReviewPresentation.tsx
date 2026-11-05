"use client";

import clsx from "clsx";
import Link from "next/link";
import { ArrowLeft, RefreshCw, Save, Send } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

// Shared by the ordinary essay, both correction measurers and displayed lines.
// Container padding belongs to the scroll region, never to individual lines.
export const REVIEW_ESSAY_TEXT_CLASS = "whitespace-pre-wrap text-[15px] font-normal leading-8 text-student-text";

export function ReviewWorkspaceFrame({ children }: { children: ReactNode }) {
  return <div className="teacher-shell flex h-[calc(100dvh-24px)] min-h-0 flex-col overflow-hidden rounded-xl border border-student-border bg-white shadow-[0_2px_14px_rgba(60,47,119,0.06)]">{children}</div>;
}

export function ReviewWorkspaceGrid({ children }: { children: ReactNode }) {
  return <div className="writing-review-grid min-h-0 flex-1 bg-[#f8f7fc] p-2">{children}</div>;
}

export function ReviewToolbar({ title, status, displayName, returnTo, children }: {
  title: string; status: string; displayName?: string; returnTo: string; children: ReactNode;
}) {
  return <header className="z-10 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-student-border bg-white px-3 py-2.5">
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <Link aria-label="返回来源页面" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-student-primary hover:bg-student-primary-soft" href={returnTo}><ArrowLeft aria-hidden="true" size={17} /></Link>
      <strong className="text-sm">{title}</strong>
      <span className="text-student-muted">/</span>
      <span className="font-semibold text-student-primary">{status}</span>
      <span className="hidden truncate text-student-muted sm:inline">/ {displayName}</span>
    </div>
    <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
  </header>;
}

export function ReviewToolbarButton({ primary = false, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return <button {...props} className={clsx(primary ? "teacher-button-primary" : "teacher-button-secondary", "!min-h-8 !px-3 !py-1 text-xs", className)} type="button" />;
}

/** Presentation only. Disabled rules, messages, requests and confirmations stay
 * with each business workspace; no ordinary/correction payload is merged. */
export function ReviewToolbarActions({ generateLabel, statusText, error = false, generateDisabled, saveDisabled, publishDisabled, onGenerate, onSave, onPublish }: {
  generateLabel: string; statusText: string; error?: boolean;
  generateDisabled: boolean; saveDisabled: boolean; publishDisabled: boolean;
  onGenerate: () => void; onSave: () => void; onPublish: () => void;
}) {
  return <>
    <ReviewToolbarButton disabled={generateDisabled} onClick={onGenerate}><RefreshCw aria-hidden="true" size={14} />{generateLabel}</ReviewToolbarButton>
    <span aria-live="polite" className={clsx("text-[11px]", error ? "text-red-600" : "text-student-muted")}>{statusText}</span>
    <ReviewToolbarButton disabled={saveDisabled} onClick={onSave}><Save aria-hidden="true" size={14} />保存</ReviewToolbarButton>
    <ReviewToolbarButton primary disabled={publishDisabled} onClick={onPublish}><Send aria-hidden="true" size={14} />发布</ReviewToolbarButton>
  </>;
}

export function ReviewFilterChip({ active = false, children, onClick }: { active?: boolean; children: ReactNode; onClick?: () => void }) {
  const className = clsx("rounded-md border px-1.5 py-1 text-[10px] font-semibold", active ? "border-student-primary bg-student-primary-soft text-student-primary" : "border-student-border bg-white text-student-muted");
  return onClick ? <button className={className} onClick={onClick} type="button">{children}</button> : <span className={className}>{children}</span>;
}

export const ReviewFeedbackCard = forwardRef<HTMLElement, HTMLAttributes<HTMLElement> & { selected?: boolean; muted?: boolean }>(function ReviewFeedbackCard({ selected = false, muted = false, className, ...props }, ref) {
  return <article {...props} ref={ref} className={clsx("rounded-lg border p-2.5 text-[11px] leading-[1.55] transition", muted ? "bg-student-bg opacity-55" : "bg-white", selected ? "border-student-primary ring-2 ring-violet-200" : "border-student-border", className)} />;
});

export function ReviewFeedbackLine({ label, value }: { label: string; value: ReactNode }) {
  return <p className="mt-1.5"><strong>{label}：</strong>{value}</p>;
}

export function ReviewBadge({ children, toneClass = "bg-student-bg text-student-muted" }: { children: ReactNode; toneClass?: string }) {
  return <span className={clsx("rounded px-1.5 py-0.5 text-[9px] font-semibold", toneClass)}>{children}</span>;
}

export function ReviewScoreTable({ headings, columns, children }: { headings: string[]; columns: string; children: ReactNode }) {
  return <div className="overflow-hidden rounded-lg border border-student-border">
    <div className="grid bg-student-bg px-2 py-1.5 text-[9px] font-semibold text-student-muted" style={{ gridTemplateColumns: columns }}>{headings.map(label => <span key={label}>{label}</span>)}</div>
    {children}
  </div>;
}

export function ReviewScoreRow({ columns, children }: { columns: string; children: ReactNode }) {
  return <div className="grid items-start gap-1 border-t border-student-border px-2 py-2 text-[10px] leading-4" style={{ gridTemplateColumns: columns }}>{children}</div>;
}

export function ReviewScoreRationale(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className="mt-1 h-16 w-full resize-none rounded-md border border-student-border bg-white px-2 py-1.5 text-[10px] font-normal leading-4 text-student-text focus:border-student-primary" />;
}

export function ReviewSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className="h-7 rounded-md border border-student-border bg-white px-1 text-xs font-bold text-student-primary" />;
}

export function ReviewOfficialScoreCard({ title = "官方整体评分", aiScore, teacherControl, teacherLabel = "教师最终", rationaleLabel = "参考", rationale, children }: {
  title?: string; aiScore: ReactNode; teacherControl: ReactNode; teacherLabel?: string; rationaleLabel?: string; rationale: ReactNode; children?: ReactNode;
}) {
  return <div className="mt-2 rounded-lg border border-student-primary-border bg-student-primary-soft/30 p-2.5">
    <div className="flex items-center justify-between gap-2">
      <div><p className="text-xs font-bold">{title}</p><p className="mt-1 text-[10px] font-semibold text-student-primary">AI：{aiScore}</p></div>
      <label className="flex items-center gap-1 text-[10px] font-semibold">{teacherLabel}{teacherControl}</label>
    </div>
    <label className="mt-2 block text-[10px] font-semibold text-student-muted">{rationaleLabel}{rationale}</label>
    {children}
  </div>;
}
