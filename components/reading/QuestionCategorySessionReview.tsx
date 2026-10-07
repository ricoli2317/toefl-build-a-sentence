"use client";
import { ReadingSessionBundleReview } from "./ReadingSessionBundleReview";

export function QuestionCategorySessionReview({ sessionId, initialReviewIndex, returnTo }: {
  sessionId: string; initialReviewIndex: number; returnTo?: string | null;
}) {
  return <ReadingSessionBundleReview sessionId={sessionId} initialReviewIndex={initialReviewIndex} returnTo={returnTo} kind="category"
    lexicalAccess={{ kind: "reading_category", attemptId: sessionId }} />;
}
