import {
  buildWritingReviewPublishUpdate,
  buildWritingReviewSaveUpdate,
  type WritingReviewWorkingDraft
} from "./writingReviewWorkspace.ts";

export type RecoverableWritingReview = WritingReviewWorkingDraft & {
  review_id: string | null;
  status: "pending" | "reviewing" | "published" | "ignored";
  has_ai_review: boolean;
  published_language_edits?: unknown;
  published_scores?: unknown;
  published_content_feedback?: unknown;
  published_teacher_comment?: string | null;
  published_sample_essay?: string | null;
  sample_essay_draft?: string | null;
};

export type WritingReviewUnknownOutcomeOperation =
  | "generate"
  | "save"
  | "publish";

export async function recoverWritingReviewAfterUnknownOutcome(
  operation: WritingReviewUnknownOutcomeOperation,
  draft: WritingReviewWorkingDraft | null,
  reload: () => Promise<RecoverableWritingReview>,
  sampleEssayDraft?: string | null
) {
  const review = await reload();
  if (operation === "generate") {
    // Generating AI content on an ignored review keeps the ignored lifecycle
    // state until the teacher really Saves / Publishes, so it still counts as
    // a persisted generation.
    return review.review_id &&
      review.has_ai_review &&
      (review.status === "reviewing" ||
        review.status === "published" ||
        review.status === "ignored")
      ? review
      : null;
  }
  if (!draft || !review.review_id) return null;
  // undefined means the request never carried a sample essay; a present value
  // must have reached the row for the mutation to count as persisted.
  const requestedSampleEssay =
    sampleEssayDraft === undefined
      ? undefined
      : comparableSampleEssayDraft(sampleEssayDraft);
  const sampleEssayPersisted =
    requestedSampleEssay === undefined ||
    (review.sample_essay_draft ?? null) === requestedSampleEssay;
  if (operation === "save") {
    if (!sampleEssayPersisted) return null;
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
    "1970-01-01T00:00:00.000Z",
    requestedSampleEssay === undefined
      ? review.sample_essay_draft ?? null
      : requestedSampleEssay
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
    review.published_teacher_comment === expected.published_teacher_comment &&
    (expected.published_sample_essay === undefined ||
      (review.published_sample_essay ?? null) === expected.published_sample_essay) &&
    sampleEssayPersisted
  )
    ? review
    : null;
}

function comparableSampleEssayDraft(value: string | null) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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
