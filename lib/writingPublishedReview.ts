import type { WritingTaskType } from "./writing.ts";
import type {
  CompatibleWorkingReviewScores,
  WorkingContentFeedbackItem,
  WorkingLanguageEdit,
  WritingReviewWorkingDraft
} from "./writingReviewWorkspace.ts";

export type PublishedReviewItem =
  | { id: string; kind: "language_edit"; position: number; edit: WorkingLanguageEdit }
  | {
      id: string;
      kind: "content_feedback";
      position: number;
      feedback: WorkingContentFeedbackItem;
    };

export type PublishedWritingReviewSnapshot = WritingReviewWorkingDraft & {
  overall_evaluation: string;
  published_at: string;
};

export type StudentPublishedWritingReview = {
  language_edits: WorkingLanguageEdit[];
  content_feedback: { items: WorkingContentFeedbackItem[] };
  scores: {
    official_score: { score: number; rationale: string };
    dimension_scores: Record<string, { score: number; rationale: string }> | null;
  };
  overall_evaluation: string;
  published_at: string;
};

export class PublishedWritingReviewSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishedWritingReviewSnapshotError";
  }
}

/**
 * Hydrates the immutable Publish payload for shared composition helpers. It only
 * adds the working-only flags removed while freezing the snapshot; it never
 * reads or merges the current working review.
 */
export function hydratePublishedWritingReviewSnapshot(input: {
  taskType: WritingTaskType;
  responseText: string;
  publishedLanguageEdits: unknown;
  publishedScores: unknown;
  publishedContentFeedback: unknown;
  publishedTeacherComment: unknown;
  publishedAt: unknown;
}): PublishedWritingReviewSnapshot {
  if (!Array.isArray(input.publishedLanguageEdits)) {
    throw invalidSnapshot();
  }
  if (!isRecord(input.publishedScores)) {
    throw invalidSnapshot();
  }
  if (
    !isRecord(input.publishedContentFeedback) ||
    !Array.isArray(input.publishedContentFeedback.items) ||
    typeof input.publishedContentFeedback.overall_feedback !== "string"
  ) {
    throw invalidSnapshot();
  }
  if (typeof input.publishedAt !== "string" || !input.publishedAt) {
    throw invalidSnapshot();
  }

  const languageEdits = input.publishedLanguageEdits.map((value) => {
    if (!isPublishedLanguageEdit(value, input.responseText)) throw invalidSnapshot();
    return { ...value, restored: false } as WorkingLanguageEdit;
  });
  const contentItems = input.publishedContentFeedback.items.map((value) => {
    if (!isPublishedContentFeedback(value, input.responseText)) throw invalidSnapshot();
    return { ...value, included: true } as WorkingContentFeedbackItem;
  });
  const scores = input.publishedScores as CompatibleWorkingReviewScores;
  if (!isPublishedScores(scores, input.taskType)) throw invalidSnapshot();
  const teacherComment =
    typeof input.publishedTeacherComment === "string"
      ? input.publishedTeacherComment
      : "";
  const overallFeedback = input.publishedContentFeedback.overall_feedback;

  return {
    language_edits: languageEdits,
    scores,
    content_feedback: {
      rubric_analysis: {},
      items: contentItems,
      overall_feedback: overallFeedback
    },
    teacher_comment: teacherComment,
    overall_evaluation: teacherComment.trim() || overallFeedback,
    published_at: input.publishedAt
  };
}

/**
 * Returns every published annotation the student can inspect in the marked
 * essay. This collection intentionally does not use clean-composition
 * suppression: an overlapping language edit remains selectable even when a
 * content revision takes priority while composing the clean revised essay.
 */
export function orderedPublishedReviewItems(
  review: Pick<StudentPublishedWritingReview, "language_edits" | "content_feedback">
): PublishedReviewItem[] {
  const seenLanguageEdits = new Set<string>();
  const seenFeedback = new Set<string>();
  const items: PublishedReviewItem[] = [];

  for (const edit of review.language_edits) {
    if (edit.restored || seenLanguageEdits.has(edit.edit_id)) continue;
    seenLanguageEdits.add(edit.edit_id);
    items.push({
      id: edit.edit_id,
      kind: "language_edit",
      position: edit.start,
      edit
    });
  }

  for (const feedback of review.content_feedback.items) {
    if (feedback.included === false || seenFeedback.has(feedback.feedback_id)) continue;
    seenFeedback.add(feedback.feedback_id);
    items.push({
      id: feedback.feedback_id,
      kind: "content_feedback",
      position: "start" in feedback && typeof feedback.start === "number"
        ? feedback.start
        : Number.MAX_SAFE_INTEGER,
      feedback
    });
  }

  return items.sort(
    (left, right) =>
      left.position - right.position ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id)
  );
}

export function publishedReviewItemsForTab(
  items: PublishedReviewItem[],
  tab: "all" | "language_edit" | "content_feedback"
) {
  return tab === "all" ? items : items.filter((item) => item.kind === tab);
}

/** Removes every frozen field that the student result page does not render. */
export function toStudentPublishedWritingReview(
  snapshot: PublishedWritingReviewSnapshot
): StudentPublishedWritingReview {
  return {
    language_edits: snapshot.language_edits.map((edit) => ({
      edit_id: edit.edit_id,
      start: edit.start,
      end: edit.end,
      original_text: edit.original_text,
      replacement_text: edit.replacement_text,
      category: edit.category,
      severity: edit.severity,
      explanation: edit.explanation,
      restored: false
    })),
    content_feedback: {
      items: snapshot.content_feedback.items.map(studentFeedbackItem)
    },
    scores: {
      official_score: {
        score: snapshot.scores.official_score.teacher_score,
        rationale: snapshot.scores.official_score.rationale
      },
      dimension_scores: snapshot.scores.dimension_scores
        ? Object.fromEntries(
            Object.entries(snapshot.scores.dimension_scores).map(([key, value]) => [
              key,
              { score: value.teacher_score, rationale: value.ai_basis }
            ])
          )
        : null
    },
    overall_evaluation: snapshot.overall_evaluation,
    published_at: snapshot.published_at
  };
}

function studentFeedbackItem(
  item: WorkingContentFeedbackItem
): WorkingContentFeedbackItem {
  const result: Record<string, unknown> = {
    feedback_id: item.feedback_id,
    category: item.category,
    issue: item.issue,
    suggestion: item.suggestion,
    included: true
  };
  if ("start" in item && typeof item.start === "number") result.start = item.start;
  if ("end" in item && typeof item.end === "number") result.end = item.end;
  if ("original_sentence" in item && typeof item.original_sentence === "string") {
    result.original_sentence = item.original_sentence;
  }
  if ("proposed_revision" in item && typeof item.proposed_revision === "string") {
    result.proposed_revision = item.proposed_revision;
  }
  return result as WorkingContentFeedbackItem;
}

function isPublishedLanguageEdit(
  value: unknown,
  responseText: string
): value is Omit<WorkingLanguageEdit, "restored"> {
  if (!isRecord(value)) return false;
  const start = value.start;
  const end = value.end;
  return (
    typeof value.edit_id === "string" &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    typeof value.original_text === "string" &&
    typeof value.replacement_text === "string" &&
    typeof value.category === "string" &&
    typeof value.severity === "string" &&
    typeof value.explanation === "string" &&
    (start as number) >= 0 &&
    (end as number) > (start as number) &&
    (end as number) <= responseText.length &&
    responseText.slice(start as number, end as number) === value.original_text
  );
}

function isPublishedContentFeedback(
  value: unknown,
  responseText: string
): value is Omit<WorkingContentFeedbackItem, "included"> {
  if (
    !isRecord(value) ||
    typeof value.feedback_id !== "string" ||
    typeof value.category !== "string" ||
    typeof value.issue !== "string" ||
    typeof value.suggestion !== "string"
  ) {
    return false;
  }
  const hasLocation =
    Number.isInteger(value.start) &&
    Number.isInteger(value.end) &&
    typeof value.original_sentence === "string";
  if (!hasLocation) return true;
  return (
    (value.start as number) >= 0 &&
    (value.end as number) > (value.start as number) &&
    (value.end as number) <= responseText.length &&
    responseText.slice(value.start as number, value.end as number) ===
      value.original_sentence
  );
}

function isPublishedScores(
  value: CompatibleWorkingReviewScores,
  taskType: WritingTaskType
) {
  if (!isRecord(value.official_score)) return false;
  const official = value.official_score;
  if (
    !isScore(official.teacher_score) ||
    !isScore(official.ai_score) ||
    typeof official.rationale !== "string"
  ) {
    return false;
  }
  if (value.dimension_scores === null) return true;
  if (!isRecord(value.dimension_scores)) return false;
  const expected = taskType === "email"
    ? [
        "communicative_purpose_and_elaboration",
        "syntactic_range_and_word_choice",
        "social_conventions",
        "lexical_and_grammatical_control"
      ]
    : [
        "relevance",
        "elaboration",
        "syntactic_range_and_word_choice",
        "lexical_and_grammatical_control"
      ];
  return expected.every((key) => {
    const dimension = value.dimension_scores?.[key as keyof typeof value.dimension_scores];
    return (
      isRecord(dimension) &&
      isScore(dimension.teacher_score) &&
      isScore(dimension.ai_score) &&
      typeof dimension.ai_basis === "string"
    );
  });
}

function isScore(value: unknown) {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 5;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidSnapshot() {
  return new PublishedWritingReviewSnapshotError("已发布批改数据格式无效。");
}
