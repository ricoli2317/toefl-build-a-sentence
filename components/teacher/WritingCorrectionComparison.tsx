"use client";

import { useMemo } from "react";
import { REVIEW_ESSAY_TEXT_CLASS } from "./WritingReviewPresentation";
import { WritingRevisionEditor } from "@/components/writing/WritingRevisionEditor";
import { initializeWritingRevision, type WritingRevisionState } from "@/lib/writingRevisionState";

/** One continuous revision view. Persisted submissions NEVER run Diff. */
export function WritingCorrectionComparison({ original, corrected, revisionState }: {
  original: string; corrected: string; revisionState?: WritingRevisionState | null;
}) {
  const state = useMemo(() => initializeWritingRevision(original, corrected, revisionState), [original, corrected, revisionState]);
  return <div className="relative mx-auto max-w-[860px]" data-testid="correction-comparison">
    <WritingRevisionEditor key={JSON.stringify(state)} initialState={state} teacher readOnly className={REVIEW_ESSAY_TEXT_CLASS} />
  </div>;
}
