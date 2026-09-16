"use client";

import type { ReadingFullSetOccurrencePracticePayload } from "./fullSetAttempts.ts";
import type { ReadingFullSetReviewPayload } from "./fullSetReview.ts";
import type { ReadingFullSetResultPayload } from "./fullSetResults.ts";

export type ReadingFullSetReadonlySnapshot = {
  result: ReadingFullSetResultPayload;
  review: ReadingFullSetReviewPayload;
};

export function isReadingFullSetReadonlySnapshot(input: {
  attemptId: string;
  fullSetId: string;
  result?: ReadingFullSetResultPayload;
  review?: ReadingFullSetReviewPayload;
}): input is {
  attemptId: string;
  fullSetId: string;
  result: ReadingFullSetResultPayload;
  review: ReadingFullSetReviewPayload;
} {
  if (!(input.result?.attempt.attemptId === input.attemptId
    && input.result.attempt.fullSetId === input.fullSetId
    && input.review?.attempt.attemptId === input.attemptId
    && input.review.attempt.fullSetId === input.fullSetId
    && Array.isArray(input.result.answers)
    && Array.isArray(input.review.reviewItems)
    && Array.isArray(input.review.occurrences))) return false;
  const expectedOccurrences = new Set(input.result.answers.map((answer) => answer.occurrenceId));
  const snapshotOccurrences = new Set(input.review.occurrences.map((occurrence) => occurrence.occurrenceId));
  return expectedOccurrences.size === snapshotOccurrences.size
    && Array.from(expectedOccurrences).every((occurrenceId) => snapshotOccurrences.has(occurrenceId));
}

/**
 * Server scoring/disclosures remain authoritative. Practice content and the
 * just-flushed answer state are reused from the active runner when available,
 * preserving already parsed RDL maps and RAP/CTW passage objects.
 */
export function mergeReadingFullSetReviewWithHotOccurrences(
  result: ReadingFullSetResultPayload,
  review: ReadingFullSetReviewPayload,
  hotOccurrences: ReadonlyMap<string, ReadingFullSetOccurrencePracticePayload>
): ReadingFullSetReviewPayload {
  const serverOccurrences = new Map(review.occurrences.map((occurrence) => [
    occurrence.occurrenceId,
    occurrence
  ]));
  const occurrenceMetadata = Array.from(new Map(result.answers.map((answer) => [
    answer.occurrenceId,
    { moduleNumber: answer.moduleNumber, occurrenceId: answer.occurrenceId }
  ])).values());
  return {
    ...review,
    occurrences: occurrenceMetadata.flatMap((occurrence) => {
      const hot = hotOccurrences.get(occurrence.occurrenceId);
      if (
        !hot
        || hot.occurrence.occurrenceId !== occurrence.occurrenceId
      ) {
        const server = serverOccurrences.get(occurrence.occurrenceId);
        return server ? [server] : [];
      }
      return [{
        ...occurrence,
        answers: hot.answers,
        practice: hot.practice
      }];
    })
  };
}
