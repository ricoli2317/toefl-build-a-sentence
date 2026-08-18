import {
  buildWritingReviewPublishUpdate,
  buildWritingReviewSaveUpdate,
  type WritingReviewWorkingDraft
} from "./writingReviewWorkspace.ts";

export type RecoverableWritingReview = WritingReviewWorkingDraft & {
  review_id: string | null;
  status: "pending" | "reviewing" | "published";
  has_ai_review: boolean;
  published_language_edits?: unknown;
  published_scores?: unknown;
  published_content_feedback?: unknown;
  published_teacher_comment?: string | null;
};

export type WritingReviewUnknownOutcomeOperation =
  | "generate"
  | "save"
  | "publish";

export async function recoverWritingReviewAfterUnknownOutcome(
  operation: WritingReviewUnknownOutcomeOperation,
  draft: WritingReviewWorkingDraft | null,
  reload: () => Promise<RecoverableWritingReview>
) {
  const review = await reload();
  if (operation === "generate") {
    return review.review_id &&
      review.has_ai_review &&
      (review.status === "reviewing" || review.status === "published")
      ? review
      : null;
  }
  if (!draft || !review.review_id) return null;
  if (operation === "save") {
    const expected = buildWritingReviewSaveUpdate(draft);
    return (
      jsonValuesEqual(review.language_edits, expected.language_edits) &&
      jsonValuesEqual(review.scores, expected.scores) &&
      jsonValuesEqual(
        comparableContentFeedback(review),
        expected.content_feedback
      ) &&
      review.teacher_comment === expected.teacher_comment
    )
      ? review
      : null;
  }
  if (review.status !== "published") return null;
  const expected = buildWritingReviewPublishUpdate(
    draft,
    "1970-01-01T00:00:00.000Z"
  );
  return (
    jsonValuesEqual(
      review.published_language_edits,
      expected.published_language_edits
    ) &&
    jsonValuesEqual(review.published_scores, expected.published_scores) &&
    jsonValuesEqual(
      review.published_content_feedback,
      expected.published_content_feedback
    ) &&
    review.published_teacher_comment === expected.published_teacher_comment
  )
    ? review
    : null;
}

function comparableContentFeedback(review: WritingReviewWorkingDraft) {
  return review.scores.dimension_scores === null
    ? review.content_feedback
    : {
        items: review.content_feedback.items,
        overall_feedback: review.content_feedback.overall_feedback
      };
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && jsonValuesEqual(left[key], right[key])
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
