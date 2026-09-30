"use client";

import { useRouter } from "next/navigation";
import type { ReadingModule } from "@/lib/reading/types";

/**
 * Entry-level Reading correction for one submitted attempt. The current review /
 * result URL travels as `returnTo`, so finishing the correction returns to the
 * exact page the student came from. The server derives pending semantics from
 * the source attempt itself.
 */
export function ReadingCorrectionEntryButton({
  attemptId,
  label = "错题订正",
  returnTo,
  taskType
}: {
  attemptId: string;
  label?: string;
  /** Explicit origin page; defaults to the current page URL at click time. */
  returnTo?: string | null;
  taskType: ReadingModule;
}) {
  const router = useRouter();
  return (
    <button
      className="student-button-correction"
      data-testid="reading-correction-entry"
      onClick={() => {
        const origin = returnTo?.trim()
          || (typeof window === "undefined"
            ? `/student/reading/results/${encodeURIComponent(attemptId)}`
            : `${window.location.pathname}${window.location.search}`);
        router.push(`/student/wrong-questions/entry/reading/practice?${new URLSearchParams({
          attemptId,
          returnTo: origin,
          taskType
        }).toString()}`);
      }}
      type="button"
    >
      {label}
    </button>
  );
}

/**
 * Full Set corrections keep their existing multi-occurrence flow; the result
 * page only forwards its own URL so Back / finish returns to this result.
 */
export function ReadingFullSetCorrectionEntryButton({ attemptId }: { attemptId: string }) {
  const router = useRouter();
  return (
    <button
      className="student-button-correction"
      data-testid="reading-full-set-correction-entry"
      onClick={() => {
        const returnTo = typeof window === "undefined"
          ? `/student/reading/full-sets`
          : `${window.location.pathname}${window.location.search}`;
        router.push(`/student/wrong-questions/history/reading/practice?${new URLSearchParams({
          returnTo,
          sourceAttemptId: attemptId,
          taskType: "full_set"
        }).toString()}`);
      }}
      type="button"
    >
      错题订正
    </button>
  );
}
