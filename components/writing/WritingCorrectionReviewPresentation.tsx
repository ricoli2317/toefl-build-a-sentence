"use client";

import { useEffect, type ReactNode } from "react";
import type { CorrectionCompletion, CorrectionSourceIssue } from "@/lib/writingCorrectionReview";
import type { CorrectionResolutionStatus } from "@/lib/writingCorrectionReviewSchema";
import { CORRECTION_ISSUE_TYPE_LABEL, CORRECTION_STATUS_LABEL, CORRECTION_STATUS_ORDER, CORRECTION_STATUS_TONE, correctionCompletionSummary } from "@/lib/writingCorrectionReviewUi";
import { CONTENT_FEEDBACK_MARKER_CLASS, languageEditSeverityLabel, languageEditSeverityMarkerClass, writingReviewCategoryLabel } from "@/lib/writingReviewWorkspaceUi";
import { ReviewBadge, ReviewFeedbackCard, ReviewFeedbackLine } from "@/components/teacher/WritingReviewPresentation";

export function useCorrectionBlankDeselection(selectedId: string | null, clear: () => void) {
  useEffect(() => {
    if (!selectedId) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest || target.closest('[data-correction-review-item], .tiptap p, .revision-deleted, [data-correction-highlight], button, a, input, select, textarea, label, [role="button"], [contenteditable="true"], summary, [role="dialog"]')) return;
      if (event.clientX >= document.documentElement.clientWidth) return;
      const scroller = target.closest<HTMLElement>('[data-revision-scroll], [data-correction-review-scroll]');
      if (scroller && event.clientX >= scroller.getBoundingClientRect().left + scroller.clientLeft + scroller.clientWidth) return;
      clear();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [selectedId, clear]);
}

export function CorrectionCompletionPanel({ completion, summary }: { completion: CorrectionCompletion; summary?: ReactNode }) {
  return <>
    <div className="flex items-center justify-between gap-2"><p className="text-3xl font-bold leading-tight tabular-nums">{correctionCompletionSummary(completion).label}</p>{summary}</div>
    {completion.rate !== null ? <div aria-label="订正完成度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={completion.rate * 100} className="mt-3 h-1.5 overflow-hidden rounded-full bg-student-primary-soft" role="progressbar"><div className="h-full rounded-full bg-student-primary" style={{ width: `${completion.rate * 100}%` }} /></div> : null}
    <dl className="mt-3 grid grid-cols-2 gap-2">{CORRECTION_STATUS_ORDER.map(status => <div data-completion-stat className={`flex h-8 items-center justify-between gap-2 rounded-md px-2 py-1.5 ${CORRECTION_STATUS_TONE[status]}`} key={status}><dt className="whitespace-nowrap text-sm font-semibold leading-5">{CORRECTION_STATUS_LABEL[status]}</dt><dd className="text-xl font-bold leading-5 tabular-nums">{completion.counts[status]}</dd></div>)}</dl>
  </>;
}

export function CorrectionIssueCard({ issue, selected, onLocate, status, explanation, children, badge }: {
  issue: Omit<CorrectionSourceIssue, "weight" | "severity"> & { severity?: string | null };
  selected: boolean; onLocate: () => void; status?: CorrectionResolutionStatus | null;
  explanation?: string; children?: ReactNode; badge?: ReactNode;
}) {
  return <ReviewFeedbackCard data-correction-review-item={issue.issue_id} selected={selected} onClick={event => {
    if (!(event.target as Element).closest('button, a, input, select, textarea, label')) onLocate();
  }} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onLocate(); } }} tabIndex={0}>
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={issue.issue_type === "content_feedback" ? CONTENT_FEEDBACK_MARKER_CLASS : "font-semibold"}>{CORRECTION_ISSUE_TYPE_LABEL[issue.issue_type] ?? issue.issue_type}</span>
      <span className="font-semibold text-student-primary">{writingReviewCategoryLabel(issue.category)}</span>
      {issue.severity === "major" || issue.severity === "moderate" || issue.severity === "minor" ? <span className={languageEditSeverityMarkerClass(issue.severity)}>{languageEditSeverityLabel(issue.severity)}</span> : null}{badge}
    </div>
    {issue.issue_type === "language_edit" ? <ReviewFeedbackLine label="原文 / 建议" value={<><span className="line-through">{issue.original_text}</span>{" → "}<span className="font-medium">{issue.replacement_text}</span></>} /> : <ReviewFeedbackLine label="对应原句" value={issue.original_sentence} />}
    {issue.issue ? <ReviewFeedbackLine label="问题" value={issue.issue} /> : null}
    {issue.suggestion ? <ReviewFeedbackLine label="建议" value={issue.suggestion} /> : null}
    {status ? <div className="mt-2 rounded-md bg-student-bg p-2"><strong>最终判定 </strong><ReviewBadge toneClass={CORRECTION_STATUS_TONE[status]}>{CORRECTION_STATUS_LABEL[status]}</ReviewBadge>{explanation ? <p className="mt-1.5 whitespace-pre-wrap">{explanation}</p> : null}</div> : null}
    {children}
  </ReviewFeedbackCard>;
}
