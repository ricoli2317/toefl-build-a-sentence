import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WRITING_REVIEW_CURRENT_EXPORT_CASES = [
  {
    case_label: "email_weak",
    attempt_id: "cde72af6-e6d0-439b-b3ac-91fb2ab117b1",
    task_type: "email",
    file_name: "email-weak-current.json"
  },
  {
    case_label: "ad_weak",
    attempt_id: "a7ad7e9f-b4ef-4ee0-9b39-43f1d7020cdc",
    task_type: "academic_discussion",
    file_name: "ad-weak-current.json"
  }
] as const;

export const WRITING_REVIEW_CURRENT_EXPORT_OUTPUT_DIR =
  "tmp/writing-review-production-export";
export const WRITING_REVIEW_CURRENT_EXPORT_SUMMARY_FILE =
  "current-reviews-summary.json";

type ExportCase = (typeof WRITING_REVIEW_CURRENT_EXPORT_CASES)[number];
type WritingTaskType = ExportCase["task_type"];
type JsonRecord = Record<string, unknown>;

export type WritingReviewCurrentAttemptRow = {
  attempt_id: string;
  task_type: WritingTaskType;
  response_text: string;
};

export type WritingReviewCurrentReviewRow = {
  attempt_id: string;
  task_type: WritingTaskType;
  ai_model: string | null;
  ai_generated_at: string | null;
  ai_review_raw: unknown;
  scores: unknown;
  language_edits: unknown;
  content_feedback: unknown;
  teacher_comment: unknown;
};

export type WritingReviewCurrentExport = {
  attempt_id: string;
  task_type: WritingTaskType;
  response_text: string;
  ai_model: string | null;
  ai_generated_at: string | null;
  scores: unknown;
  language_edits: unknown;
  content_feedback: unknown;
  teacher_comment: string;
  overall_feedback?: string;
};

export type WritingReviewCurrentSummaryItem = {
  attempt_id: string;
  task_type: WritingTaskType;
  ai_model: string | null;
  ai_generated_at: string | null;
  official_score: number | null;
  dimension_scores: Record<string, number>;
  language_edit_count: number;
  content_feedback_count: number;
  content_feedback_categories: Record<string, number>;
};

export function buildWritingReviewCurrentExport(
  exportCase: ExportCase,
  attempt: WritingReviewCurrentAttemptRow,
  review: WritingReviewCurrentReviewRow
): WritingReviewCurrentExport {
  assertAligned(exportCase, attempt, review);
  if (!Array.isArray(review.language_edits)) {
    throw new Error(`Current language edits are invalid for ${exportCase.case_label}.`);
  }
  if (!isRecord(review.content_feedback)) {
    throw new Error(
      `Current content feedback is invalid for ${exportCase.case_label}.`
    );
  }
  if (!isRecord(review.scores)) {
    throw new Error(`Current scores are invalid for ${exportCase.case_label}.`);
  }
  if (typeof review.teacher_comment !== "string") {
    throw new Error(
      `Current teacher comment is invalid for ${exportCase.case_label}.`
    );
  }

  const overallFeedback = readOverallFeedback(review.ai_review_raw);
  return {
    attempt_id: attempt.attempt_id,
    task_type: attempt.task_type,
    response_text: attempt.response_text,
    ai_model: review.ai_model,
    ai_generated_at: review.ai_generated_at,
    scores: structuredClone(review.scores),
    language_edits: structuredClone(review.language_edits),
    content_feedback: structuredClone(review.content_feedback),
    teacher_comment: review.teacher_comment,
    ...(overallFeedback === null
      ? {}
      : { overall_feedback: overallFeedback })
  };
}

export function buildWritingReviewCurrentSummary(
  exports: WritingReviewCurrentExport[]
): WritingReviewCurrentSummaryItem[] {
  assertExportSet(exports);
  return exports.map((current) => {
    const scores = isRecord(current.scores) ? current.scores : {};
    const official = isRecord(scores.official_score)
      ? scores.official_score
      : {};
    const dimensions = isRecord(scores.dimension_scores)
      ? scores.dimension_scores
      : {};
    const feedback = isRecord(current.content_feedback)
      ? current.content_feedback
      : {};
    const items = Array.isArray(feedback.items) ? feedback.items : [];
    return {
      attempt_id: current.attempt_id,
      task_type: current.task_type,
      ai_model: current.ai_model,
      ai_generated_at: current.ai_generated_at,
      official_score: numericScore(official.ai_score),
      dimension_scores: Object.fromEntries(
        Object.entries(dimensions).flatMap(([key, value]) => {
          const score = isRecord(value) ? numericScore(value.ai_score) : null;
          return score === null ? [] : [[key, score]];
        })
      ),
      language_edit_count: Array.isArray(current.language_edits)
        ? current.language_edits.length
        : 0,
      content_feedback_count: items.length,
      content_feedback_categories: countFeedbackCategories(items)
    };
  });
}

export function writeWritingReviewCurrentExportFiles(
  outputDir: string,
  exports: WritingReviewCurrentExport[],
  fileSystem: {
    mkdirSync: typeof mkdirSync;
    writeFileSync: typeof writeFileSync;
  } = { mkdirSync, writeFileSync }
) {
  assertExportSet(exports);
  fileSystem.mkdirSync(outputDir, { recursive: true });
  WRITING_REVIEW_CURRENT_EXPORT_CASES.forEach((exportCase, index) => {
    fileSystem.writeFileSync(
      join(outputDir, exportCase.file_name),
      `${JSON.stringify(exports[index], null, 2)}\n`,
      "utf8"
    );
  });
  fileSystem.writeFileSync(
    join(outputDir, WRITING_REVIEW_CURRENT_EXPORT_SUMMARY_FILE),
    `${JSON.stringify(buildWritingReviewCurrentSummary(exports), null, 2)}\n`,
    "utf8"
  );
}

function assertAligned(
  exportCase: ExportCase,
  attempt: WritingReviewCurrentAttemptRow,
  review: WritingReviewCurrentReviewRow
) {
  if (
    attempt.attempt_id !== exportCase.attempt_id ||
    review.attempt_id !== exportCase.attempt_id ||
    attempt.task_type !== exportCase.task_type ||
    review.task_type !== exportCase.task_type
  ) {
    throw new Error(`Export data mismatch for ${exportCase.case_label}.`);
  }
  if (typeof attempt.response_text !== "string") {
    throw new Error(`Response text is invalid for ${exportCase.case_label}.`);
  }
}

function assertExportSet(exports: WritingReviewCurrentExport[]) {
  if (exports.length !== WRITING_REVIEW_CURRENT_EXPORT_CASES.length) {
    throw new Error("Current review export requires exactly two cases.");
  }
  WRITING_REVIEW_CURRENT_EXPORT_CASES.forEach((exportCase, index) => {
    const current = exports[index];
    if (
      current?.attempt_id !== exportCase.attempt_id ||
      current.task_type !== exportCase.task_type
    ) {
      throw new Error(`Unexpected export order at position ${index + 1}.`);
    }
  });
}

function readOverallFeedback(value: unknown) {
  return isRecord(value) && typeof value.overall_feedback === "string"
    ? value.overall_feedback
    : null;
}

function countFeedbackCategories(items: unknown[]) {
  const counts: Record<string, number> = {};
  items.forEach((item) => {
    if (!isRecord(item) || typeof item.category !== "string") return;
    counts[item.category] = (counts[item.category] ?? 0) + 1;
  });
  return counts;
}

function numericScore(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
