"use client";

import { useMemo } from "react";
import { REVIEW_ESSAY_TEXT_CLASS } from "./WritingReviewPresentation";
import { WritingRevisionEditor } from "@/components/writing/WritingRevisionEditor";
import { initializeWritingRevision, type WritingRevisionState } from "@/lib/writingRevisionState";
import { correctionIssueLocation } from "@/lib/writingCorrectionLocation";
import type { CorrectionSourceIssue } from "@/lib/writingCorrectionReview";
import { WRITING_CORRECTION_CHANGE_STYLE, WRITING_CORRECTION_DELETION_STYLE } from "@/lib/writingCorrectionDisplay";

/** One continuous revision view. Persisted submissions NEVER run Diff. */
export function WritingCorrectionComparison({ original, corrected, revisionState, selectedIssue, locationRequest = 0, className = REVIEW_ESSAY_TEXT_CLASS }: {
  original: string; corrected: string; revisionState?: WritingRevisionState | null;
  selectedIssue?: CorrectionSourceIssue | null;
  className?: string;
  locationRequest?: number;
}) {
  const state = useMemo(() => initializeWritingRevision(original, corrected, revisionState), [original, corrected, revisionState]);
  const location = useMemo(() => {
    const resolved = selectedIssue ? correctionIssueLocation(state.ledger, selectedIssue) : null;
    return resolved ? { ...resolved, request: locationRequest } : null;
  }, [state, selectedIssue, locationRequest]);
  return <div className="relative mx-auto max-w-[860px]" data-testid="correction-comparison">
    <WritingRevisionEditor key={JSON.stringify(state)} initialState={state} teacher readOnly location={location} className={className}
      heading={<h2 className="text-sm font-bold">修订正文</h2>} />
    <div aria-label="修订图例" className="mt-2 flex gap-3 text-xs"><span style={WRITING_CORRECTION_DELETION_STYLE}>删除</span><span style={WRITING_CORRECTION_CHANGE_STYLE}>新增</span></div>
    {selectedIssue && !location ? <p role="status" className="mt-2 text-xs text-student-muted">该历史问题缺少可唯一定位的原文，未高亮无关文字。</p> : null}
  </div>;
}
