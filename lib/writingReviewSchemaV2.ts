import type { WritingTaskType } from "./writing.ts";
import {
  AIReviewValidationError,
  LANGUAGE_EDIT_CATEGORIES,
  LANGUAGE_EDIT_SEVERITIES,
  type LanguageEdit,
  type LanguageEditCategory,
  type LanguageEditSeverity,
  type RawLanguageEdit,
  type RubricScore
} from "./writingReviewSchema.ts";
import {
  normalizeLanguageEditOverlaps,
  type LanguageEditOverlapNormalizationDiagnostic
} from "./writingReviewLanguageEditNormalization.ts";
import { findReadableExactTextOccurrences } from "./writingReviewTextMatch.ts";

export const AI_REVIEW_SCHEMA_VERSION_V2 = "2.0" as const;

export const EMAIL_DIMENSION_SCORE_KEYS = [
  "communicative_purpose_and_elaboration",
  "syntactic_range_and_word_choice",
  "social_conventions",
  "lexical_and_grammatical_control"
] as const;

export const ACADEMIC_DISCUSSION_DIMENSION_SCORE_KEYS = [
  "relevance",
  "elaboration",
  "syntactic_range_and_word_choice",
  "lexical_and_grammatical_control"
] as const;

export const EMAIL_CONTENT_FEEDBACK_CATEGORIES_V2 = [
  "communicative_purpose",
  "elaboration",
  "social_conventions",
  "organization",
  "language_improvement"
] as const;

export const ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES_V2 = [
  "relevance",
  "elaboration",
  "discussion_contribution",
  "organization",
  "language_improvement"
] as const;

export type EmailDimensionScoreKey =
  (typeof EMAIL_DIMENSION_SCORE_KEYS)[number];
export type AcademicDiscussionDimensionScoreKey =
  (typeof ACADEMIC_DISCUSSION_DIMENSION_SCORE_KEYS)[number];
export type DimensionScoreKey =
  | EmailDimensionScoreKey
  | AcademicDiscussionDimensionScoreKey;

export type RawOfficialScoreV2 = {
  ai_score: RubricScore;
  rationale: string;
};

export type RawDimensionScoreV2 = {
  ai_score: RubricScore;
  ai_basis: string;
};

export type WorkingOfficialScoreV2 = RawOfficialScoreV2 & {
  teacher_score: RubricScore;
};

export type WorkingDimensionScoreV2 = RawDimensionScoreV2 & {
  teacher_score: RubricScore;
};

export type RawReviewScoresV2<Dimension extends string> = {
  official_score: RawOfficialScoreV2;
  dimension_scores: Record<Dimension, RawDimensionScoreV2>;
};

export type WorkingReviewScoresV2<Dimension extends string = DimensionScoreKey> = {
  official_score: WorkingOfficialScoreV2;
  dimension_scores: Record<Dimension, WorkingDimensionScoreV2>;
};

export type RawContentFeedbackV2<Category extends string> = {
  feedback_id: string;
  category: Category;
  original_sentence: string;
  issue: string;
  suggestion: string;
  example: string;
};

export type InternalContentFeedbackV2<Category extends string = string> =
  RawContentFeedbackV2<Category> & {
    start: number;
    end: number;
    included: boolean;
  };

export type InternalLanguageEditV2 = LanguageEdit & { restored: boolean };

export type WritingReviewLocalizationDiagnosticContext = {
  attemptId?: string;
  requestId?: string;
  /**
   * Read-only compatibility for persisted reviews created before readable-span
   * validation. Stored offsets are still checked by the workspace loader.
   */
  allowLegacyEmbeddedLanguageEditText?: boolean;
  onLanguageEditOverlapNormalization?: (
    diagnostic: LanguageEditOverlapNormalizationDiagnostic
  ) => void;
};

type BaseAIReviewRawResultV2<
  TaskType extends WritingTaskType,
  Dimension extends string,
  FeedbackCategory extends string
> = {
  schema_version: typeof AI_REVIEW_SCHEMA_VERSION_V2;
  task_type: TaskType;
  language_edits: RawLanguageEdit[];
  scores: RawReviewScoresV2<Dimension>;
  content_feedback: Array<RawContentFeedbackV2<FeedbackCategory>>;
  overall_feedback: string;
};

type BaseAIReviewResultV2<
  TaskType extends WritingTaskType,
  Dimension extends string,
  FeedbackCategory extends string
> = {
  schema_version: typeof AI_REVIEW_SCHEMA_VERSION_V2;
  task_type: TaskType;
  language_edits: InternalLanguageEditV2[];
  scores: WorkingReviewScoresV2<Dimension>;
  content_feedback: Array<InternalContentFeedbackV2<FeedbackCategory>>;
  overall_feedback: string;
};

export type EmailAIReviewRawResultV2 = BaseAIReviewRawResultV2<
  "email",
  EmailDimensionScoreKey,
  (typeof EMAIL_CONTENT_FEEDBACK_CATEGORIES_V2)[number]
>;

export type AcademicDiscussionAIReviewRawResultV2 = BaseAIReviewRawResultV2<
  "academic_discussion",
  AcademicDiscussionDimensionScoreKey,
  (typeof ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES_V2)[number]
>;

export type AIReviewRawResultV2 =
  | EmailAIReviewRawResultV2
  | AcademicDiscussionAIReviewRawResultV2;

export type EmailAIReviewResultV2 = BaseAIReviewResultV2<
  "email",
  EmailDimensionScoreKey,
  (typeof EMAIL_CONTENT_FEEDBACK_CATEGORIES_V2)[number]
>;

export type AcademicDiscussionAIReviewResultV2 = BaseAIReviewResultV2<
  "academic_discussion",
  AcademicDiscussionDimensionScoreKey,
  (typeof ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES_V2)[number]
>;

export type AIReviewResultV2 =
  | EmailAIReviewResultV2
  | AcademicDiscussionAIReviewResultV2;

export type AIReviewV2ValidationResult =
  | { success: true; data: AIReviewRawResultV2 }
  | { success: false; issues: Array<{ path: string; message: string }> };

const TOP_LEVEL_KEYS = [
  "schema_version",
  "task_type",
  "language_edits",
  "scores",
  "content_feedback",
  "overall_feedback"
] as const;
const RAW_LANGUAGE_EDIT_KEYS = [
  "edit_id",
  "original_text",
  "replacement_text",
  "category",
  "severity",
  "explanation"
] as const;
const SCORES_KEYS = ["official_score", "dimension_scores"] as const;
const RAW_OFFICIAL_SCORE_KEYS = ["ai_score", "rationale"] as const;
const RAW_DIMENSION_SCORE_KEYS = ["ai_score", "ai_basis"] as const;
const RAW_FEEDBACK_KEYS = [
  "feedback_id",
  "category",
  "original_sentence",
  "issue",
  "suggestion",
  "example"
] as const;

export function validateAIReviewRawResultV2(
  value: unknown
): AIReviewV2ValidationResult {
  const issues: Array<{ path: string; message: string }> = [];
  const review = strictObject(value, "$", TOP_LEVEL_KEYS, issues);
  if (!review) return { success: false, issues };

  if (review.schema_version !== AI_REVIEW_SCHEMA_VERSION_V2) {
    issue(issues, "$.schema_version", 'must equal "2.0"');
  }
  const taskType = review.task_type;
  if (taskType !== "email" && taskType !== "academic_discussion") {
    issue(issues, "$.task_type", 'must be "email" or "academic_discussion"');
  }

  validateRawLanguageEdits(review.language_edits, issues);
  if (taskType === "email") {
    validateRawScores(review.scores, EMAIL_DIMENSION_SCORE_KEYS, issues);
    validateRawFeedback(
      review.content_feedback,
      EMAIL_CONTENT_FEEDBACK_CATEGORIES_V2,
      issues
    );
  } else if (taskType === "academic_discussion") {
    validateRawScores(
      review.scores,
      ACADEMIC_DISCUSSION_DIMENSION_SCORE_KEYS,
      issues
    );
    validateRawFeedback(
      review.content_feedback,
      ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES_V2,
      issues
    );
  } else {
    arrayValue(review.content_feedback, "$.content_feedback", issues);
    objectValue(review.scores, "$.scores", issues);
  }
  nonEmptyString(review.overall_feedback, "$.overall_feedback", issues);

  return issues.length > 0
    ? { success: false, issues }
    : { success: true, data: review as AIReviewRawResultV2 };
}

export function parseAIReviewRawResultV2(value: unknown): AIReviewRawResultV2 {
  const validation = validateAIReviewRawResultV2(value);
  if (!validation.success) throw new AIReviewValidationError(validation.issues);
  return validation.data;
}

export function parseAIReviewRawResultV2ForResponse(
  value: unknown,
  responseText: string,
  diagnosticContext?: WritingReviewLocalizationDiagnosticContext
): AIReviewResultV2 {
  const raw = parseAIReviewRawResultV2(value);
  const issues: Array<{ path: string; message: string }> = [];
  const localizedLanguageEdits = raw.language_edits.map((edit, index) => {
    const issueCountBeforeLocalization = issues.length;
    const offsets = locateUniqueText(
      responseText,
      edit.original_text,
      `$.language_edits[${index}].original_text`,
      issues,
      diagnosticContext?.allowLegacyEmbeddedLanguageEditText !== true
    );
    return {
      edit: { ...edit, ...offsets, restored: false },
      index,
      localizationValid: issues.length === issueCountBeforeLocalization
    };
  });
  let languageEdits = localizedLanguageEdits.map(({ edit }) => edit);
  const languageLocalizationValid = localizedLanguageEdits.every(
    ({ localizationValid }) => localizationValid
  );
  if (languageLocalizationValid) {
    const normalization = normalizeLanguageEditOverlaps(
      responseText,
      languageEdits
    );
    languageEdits = normalization.edits;
    if (normalization.diagnostic) {
      diagnosticContext?.onLanguageEditOverlapNormalization?.(
        normalization.diagnostic
      );
      if (diagnosticContext?.requestId || diagnosticContext?.attemptId) {
        console.warn("[writing-review-ai] language_edit_overlap_recovered", {
          request_id: diagnosticContext.requestId ?? null,
          attempt_id: diagnosticContext.attemptId ?? null,
          error_code: "LANGUAGE_EDIT_OVERLAP"
        });
      }
    }
  }
  if (languageLocalizationValid) {
    validateLanguageEditSourceRanges(responseText, languageEdits, issues);
    validateLanguageEditOverlap(languageEdits, issues);
  }

  const contentFeedback = raw.content_feedback.map((feedback, index) => {
    const offsets = locateUniqueText(
      responseText,
      feedback.original_sentence,
      `$.content_feedback[${index}].original_sentence`,
      issues
    );
    return { ...feedback, ...offsets, included: true };
  });

  if (issues.length > 0) throw new AIReviewValidationError(issues);

  return {
    ...raw,
    language_edits: languageEdits,
    scores: buildWorkingScoresV2(
      raw.scores as RawReviewScoresV2<DimensionScoreKey>
    ),
    content_feedback: contentFeedback
  } as AIReviewResultV2;
}

export function buildWorkingScoresV2<Dimension extends string>(
  scores: RawReviewScoresV2<Dimension>
): WorkingReviewScoresV2<Dimension> {
  return {
    official_score: {
      ...scores.official_score,
      teacher_score: scores.official_score.ai_score
    },
    dimension_scores: Object.fromEntries(
      Object.entries<RawDimensionScoreV2>(scores.dimension_scores).map(
        ([key, value]) => [key, { ...value, teacher_score: value.ai_score }]
      )
    ) as Record<Dimension, WorkingDimensionScoreV2>
  };
}

function validateRawLanguageEdits(
  value: unknown,
  issues: Array<{ path: string; message: string }>
) {
  const edits = arrayValue(value, "$.language_edits", issues);
  if (!edits) return;
  const ids = new Set<string>();
  edits.forEach((item, index) => {
    const path = `$.language_edits[${index}]`;
    const edit = strictObject(item, path, RAW_LANGUAGE_EDIT_KEYS, issues);
    if (!edit) return;
    uniqueId(edit.edit_id, `${path}.edit_id`, ids, issues);
    nonEmptyString(edit.original_text, `${path}.original_text`, issues);
    stringValue(edit.replacement_text, `${path}.replacement_text`, issues);
    enumValue(edit.category, LANGUAGE_EDIT_CATEGORIES, `${path}.category`, issues);
    enumValue(edit.severity, LANGUAGE_EDIT_SEVERITIES, `${path}.severity`, issues);
    nonEmptyString(edit.explanation, `${path}.explanation`, issues);
  });
}

function validateRawScores(
  value: unknown,
  dimensionKeys: readonly string[],
  issues: Array<{ path: string; message: string }>
) {
  const scores = strictObject(value, "$.scores", SCORES_KEYS, issues);
  if (!scores) return;
  const official = strictObject(
    scores.official_score,
    "$.scores.official_score",
    RAW_OFFICIAL_SCORE_KEYS,
    issues
  );
  const officialScore = official
    ? scoreValue(official.ai_score, "$.scores.official_score.ai_score", issues)
    : null;
  if (official) {
    nonEmptyString(official.rationale, "$.scores.official_score.rationale", issues);
  }

  const dimensions = strictObject(
    scores.dimension_scores,
    "$.scores.dimension_scores",
    dimensionKeys,
    issues
  );
  if (!dimensions) return;
  dimensionKeys.forEach((key) => {
    const path = `$.scores.dimension_scores.${key}`;
    const dimension = strictObject(
      dimensions[key],
      path,
      RAW_DIMENSION_SCORE_KEYS,
      issues
    );
    if (!dimension) return;
    const dimensionScore = scoreValue(dimension.ai_score, `${path}.ai_score`, issues);
    nonEmptyString(dimension.ai_basis, `${path}.ai_basis`, issues);
    if (officialScore === 0 && dimensionScore !== null && dimensionScore !== 0) {
      issue(issues, `${path}.ai_score`, "must be 0 when official_score.ai_score is 0");
    }
    if (officialScore !== null && officialScore > 0 && dimensionScore === 0) {
      issue(
        issues,
        `${path}.ai_score`,
        "must be from 1 through 5 when official_score.ai_score is greater than 0"
      );
    }
  });
}

function validateRawFeedback(
  value: unknown,
  categories: readonly string[],
  issues: Array<{ path: string; message: string }>
) {
  const items = arrayValue(value, "$.content_feedback", issues);
  if (!items) return;
  const ids = new Set<string>();
  items.forEach((item, index) => {
    const path = `$.content_feedback[${index}]`;
    const feedback = strictObject(item, path, RAW_FEEDBACK_KEYS, issues);
    if (!feedback) return;
    uniqueId(feedback.feedback_id, `${path}.feedback_id`, ids, issues);
    enumValue(feedback.category, categories, `${path}.category`, issues);
    nonEmptyString(feedback.original_sentence, `${path}.original_sentence`, issues);
    nonEmptyString(feedback.issue, `${path}.issue`, issues);
    nonEmptyString(feedback.suggestion, `${path}.suggestion`, issues);
    stringValue(feedback.example, `${path}.example`, issues);
  });
}

function locateUniqueText(
  responseText: string,
  exactText: string,
  path: string,
  issues: Array<{ path: string; message: string }>,
  readableBoundaries = false
) {
  const occurrences = readableBoundaries
    ? findReadableExactTextOccurrences(responseText, exactText)
    : [];
  const start = readableBoundaries
    ? (occurrences[0] ?? -1)
    : responseText.indexOf(exactText);
  if (start < 0) {
    issue(issues, path, "must occur exactly in response_text");
    return { start: 0, end: exactText.length };
  }
  if (
    readableBoundaries
      ? occurrences.length > 1
      : responseText.indexOf(exactText, start + 1) >= 0
  ) {
    issue(issues, path, "must occur exactly once in response_text");
  }
  return { start, end: start + exactText.length };
}

function validateLanguageEditOverlap(
  edits: Array<{ start: number; end: number }>,
  issues: Array<{ path: string; message: string }>
) {
  const ordered = edits
    .map((edit, index) => ({ edit, index }))
    .sort((left, right) => left.edit.start - right.edit.start || left.edit.end - right.edit.end);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.edit.start < previous.edit.end) {
      issue(
        issues,
        `$.language_edits[${current.index}].start`,
        `must not overlap language_edits[${previous.index}]`
      );
    }
  }
}

function validateLanguageEditSourceRanges(
  responseText: string,
  edits: InternalLanguageEditV2[],
  issues: Array<{ path: string; message: string }>
) {
  edits.forEach((edit, index) => {
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > responseText.length
    ) {
      issue(issues, `$.language_edits[${index}]`, "must have a valid source range");
      return;
    }
    if (responseText.slice(edit.start, edit.end) !== edit.original_text) {
      issue(
        issues,
        `$.language_edits[${index}].original_text`,
        "must equal response_text.slice(start, end)"
      );
    }
  });
}

function scoreValue(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>
): RubricScore | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 5) {
    issue(issues, path, "must be an integer from 0 through 5");
    return null;
  }
  return value as RubricScore;
}

function uniqueId(
  value: unknown,
  path: string,
  ids: Set<string>,
  issues: Array<{ path: string; message: string }>
) {
  if (!nonEmptyString(value, path, issues)) return;
  if (ids.has(value)) issue(issues, path, "must be unique within this review");
  ids.add(value);
}

function strictObject(
  value: unknown,
  path: string,
  keys: readonly string[],
  issues: Array<{ path: string; message: string }>
) {
  const object = objectValue(value, path, issues);
  if (!object) return null;
  const allowed = new Set(keys);
  keys.forEach((key) => {
    if (!(key in object)) issue(issues, `${path}.${key}`, "is required");
  });
  Object.keys(object).forEach((key) => {
    if (!allowed.has(key)) issue(issues, `${path}.${key}`, "is not allowed");
  });
  return object;
}

function objectValue(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>
) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issue(issues, path, "must be an object");
    return null;
  }
  return value as Record<string, unknown>;
}

function arrayValue(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>
) {
  if (!Array.isArray(value)) {
    issue(issues, path, "must be an array");
    return null;
  }
  return value;
}

function stringValue(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>
): value is string {
  if (typeof value !== "string") {
    issue(issues, path, "must be a string");
    return false;
  }
  return true;
}

function nonEmptyString(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>
): value is string {
  if (!stringValue(value, path, issues)) return false;
  if (!value.length) {
    issue(issues, path, "must not be empty");
    return false;
  }
  return true;
}

function enumValue(
  value: unknown,
  allowed: readonly string[],
  path: string,
  issues: Array<{ path: string; message: string }>
) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    issue(issues, path, `must be one of: ${allowed.join(", ")}`);
  }
}

function issue(
  issues: Array<{ path: string; message: string }>,
  path: string,
  message: string
) {
  issues.push({ path, message });
}

const nonEmptyStringSchema = { type: "string", minLength: 1 } as const;
const scoreSchema = { type: "integer", minimum: 0, maximum: 5 } as const;
const rawLanguageEditSchema = {
  type: "object",
  additionalProperties: false,
  required: RAW_LANGUAGE_EDIT_KEYS,
  properties: {
    edit_id: nonEmptyStringSchema,
    original_text: nonEmptyStringSchema,
    replacement_text: { type: "string" },
    category: { type: "string", enum: LANGUAGE_EDIT_CATEGORIES },
    severity: { type: "string", enum: LANGUAGE_EDIT_SEVERITIES },
    explanation: nonEmptyStringSchema
  }
} as const;

function rawScoresSchema(dimensionKeys: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: SCORES_KEYS,
    properties: {
      official_score: {
        type: "object",
        additionalProperties: false,
        required: RAW_OFFICIAL_SCORE_KEYS,
        properties: { ai_score: scoreSchema, rationale: nonEmptyStringSchema }
      },
      dimension_scores: {
        type: "object",
        additionalProperties: false,
        required: dimensionKeys,
        properties: Object.fromEntries(
          dimensionKeys.map((key) => [
            key,
            {
              type: "object",
              additionalProperties: false,
              required: RAW_DIMENSION_SCORE_KEYS,
              properties: { ai_score: scoreSchema, ai_basis: nonEmptyStringSchema }
            }
          ])
        )
      }
    }
  } as const;
}

function rawFeedbackSchema(categories: readonly string[]) {
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: RAW_FEEDBACK_KEYS,
      properties: {
        feedback_id: nonEmptyStringSchema,
        category: { type: "string", enum: categories },
        original_sentence: nonEmptyStringSchema,
        issue: nonEmptyStringSchema,
        suggestion: nonEmptyStringSchema,
        example: { type: "string" }
      }
    }
  } as const;
}

function rawTaskSchema(
  taskType: WritingTaskType,
  dimensionKeys: readonly string[],
  feedbackCategories: readonly string[]
) {
  return {
    type: "object",
    additionalProperties: false,
    required: TOP_LEVEL_KEYS,
    properties: {
      schema_version: { type: "string", const: AI_REVIEW_SCHEMA_VERSION_V2 },
      task_type: { type: "string", const: taskType },
      language_edits: { type: "array", items: rawLanguageEditSchema },
      scores: rawScoresSchema(dimensionKeys),
      content_feedback: rawFeedbackSchema(feedbackCategories),
      overall_feedback: nonEmptyStringSchema
    }
  } as const;
}

export const AI_REVIEW_RAW_RESULT_V2_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "AIReviewRawResultV2",
  description:
    "TOEFL holistic score plus task-specific diagnostic dimensions and exact sentence feedback, without offsets or teacher scores.",
  oneOf: [
    rawTaskSchema(
      "email",
      EMAIL_DIMENSION_SCORE_KEYS,
      EMAIL_CONTENT_FEEDBACK_CATEGORIES_V2
    ),
    rawTaskSchema(
      "academic_discussion",
      ACADEMIC_DISCUSSION_DIMENSION_SCORE_KEYS,
      ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES_V2
    )
  ]
} as const;

export type {
  LanguageEditCategory,
  LanguageEditSeverity,
  RawLanguageEdit,
  RubricScore
};
