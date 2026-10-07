"use client";
import { ReadingSessionBundleReview } from "./ReadingSessionBundleReview";

export function ReadingWrongbookSessionReview(props: { sessionId: string; initialReviewIndex: number; returnTo?: string | null }) {
  return <ReadingSessionBundleReview {...props} kind="wrongbook" />;
}
