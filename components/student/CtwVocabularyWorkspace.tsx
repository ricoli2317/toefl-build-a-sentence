"use client";
import { WordbookReviewWorkspace } from "./WordbookReviewWorkspace";
import { useCtwReview, useCtwRetry } from "./useCtwReview";
import { CtwVocabularyReviewResult } from "./CtwVocabularyReviewResult";
import { projectCtwRound } from "@/lib/ctw-vocabulary/review";
import { VOCABULARY_ROOT } from "@/lib/ctw-vocabulary/round";

export function CtwVocabularySession({ attemptId }: { attemptId: string }) {
  const review = useCtwReview(attemptId), retry = useCtwRetry();
  const round = review.local ? projectCtwRound(review.local) : undefined;
  return <WordbookReviewWorkspace state={review.state} spellingOnly skipStudyLabel="跳过学习" busy={retry.busy}
    error={review.error || retry.error} onAction={review.action} onReload={() => void review.reload(true)}
    onRetry={() => { if (round) void retry.retry(round); }} pauseHref={`${VOCABULARY_ROOT}/history`}
    pending={review.pending} syncError={review.syncError} onSyncRetry={review.retrySync}
    draft={review.draft} onDraftChange={draft => void review.setDraft(draft)}
    resultView={round && review.state ? <CtwVocabularyReviewResult round={round} state={review.state} pending={review.pending}
      busy={retry.busy} onRetry={() => void retry.retry(round)} /> : undefined} />;
}
