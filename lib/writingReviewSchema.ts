import type { WritingTaskType } from "@/lib/writing";

export const AI_REVIEW_SCHEMA_VERSION = "1.0" as const;

export const LANGUAGE_EDIT_CATEGORIES = [
  "grammar",
  "spelling",
  "capitalization",
  "punctuation",
  "word_choice",
  "word_form",
  "syntax",
  "usage",
  "social_convention",
  "other"
] as const;

export const LANGUAGE_EDIT_SEVERITIES = ["major", "moderate", "minor"] as const;

export const EMAIL_CONTENT_FEEDBACK_CATEGORIES = [
  "communicative_purpose",
  "elaboration",
  "organization",
  "social_conventions",
  "logic",
  "other"
] as const;

export const ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES = [
  "relevance",
  "elaboration",
  "discussion_contribution",
  "logic",
  "organization",
  "other"
] as const;

export type LanguageEditCategory = (typeof LANGUAGE_EDIT_CATEGORIES)[number];
export type LanguageEditSeverity = (typeof LANGUAGE_EDIT_SEVERITIES)[number];
export type EmailContentFeedbackCategory =
  (typeof EMAIL_CONTENT_FEEDBACK_CATEGORIES)[number];
export type AcademicDiscussionContentFeedbackCategory =
  (typeof ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES)[number];
export type RubricScore = 0 | 1 | 2 | 3 | 4 | 5;

export type LanguageEdit = {
  edit_id: string;
  start: number;
  end: number;
  original_text: string;
  replacement_text: string;
  category: LanguageEditCategory;
  severity: LanguageEditSeverity;
  explanation: string;
};

export type RawLanguageEdit = Omit<LanguageEdit, "start" | "end">;

export type ReviewScore = {
  rubric_score: RubricScore;
  rationale: string;
};

export type EmailRubricAnalysis = {
  communicative_purpose_and_elaboration: string;
  syntax_and_word_choice: string;
  social_conventions: string;
  lexical_and_grammatical_control: string;
};

export type AcademicDiscussionRubricAnalysis = {
  relevance_and_elaboration: string;
  syntax_and_word_choice: string;
  lexical_and_grammatical_control: string;
};

export type ContentFeedback<Category extends string> = {
  feedback_id: string;
  category: Category;
  issue: string;
  suggestion: string;
  example: string;
};

type BaseAIReviewResult<
  TaskType extends WritingTaskType,
  RubricAnalysis,
  FeedbackCategory extends string,
  LanguageEditType = LanguageEdit
> = {
  schema_version: typeof AI_REVIEW_SCHEMA_VERSION;
  task_type: TaskType;
  language_edits: LanguageEditType[];
  score: ReviewScore;
  rubric_analysis: RubricAnalysis;
  content_feedback: Array<ContentFeedback<FeedbackCategory>>;
  overall_feedback: string;
};

export type EmailAIReviewResult = BaseAIReviewResult<
  "email",
  EmailRubricAnalysis,
  EmailContentFeedbackCategory
>;

export type AcademicDiscussionAIReviewResult = BaseAIReviewResult<
  "academic_discussion",
  AcademicDiscussionRubricAnalysis,
  AcademicDiscussionContentFeedbackCategory
>;

export type AIReviewResult = EmailAIReviewResult | AcademicDiscussionAIReviewResult;

export type EmailAIReviewRawResult = BaseAIReviewResult<
  "email",
  EmailRubricAnalysis,
  EmailContentFeedbackCategory,
  RawLanguageEdit
>;

export type AcademicDiscussionAIReviewRawResult = BaseAIReviewResult<
  "academic_discussion",
  AcademicDiscussionRubricAnalysis,
  AcademicDiscussionContentFeedbackCategory,
  RawLanguageEdit
>;

export type AIReviewRawResult =
  | EmailAIReviewRawResult
  | AcademicDiscussionAIReviewRawResult;

export type AIReviewValidationIssue = {
  path: string;
  message: string;
};

export type AIReviewValidationResult =
  | { success: true; data: AIReviewResult }
  | { success: false; issues: AIReviewValidationIssue[] };

export type AIReviewRawValidationResult =
  | { success: true; data: AIReviewRawResult }
  | { success: false; issues: AIReviewValidationIssue[] };

const TOP_LEVEL_KEYS = [
  "schema_version",
  "task_type",
  "language_edits",
  "score",
  "rubric_analysis",
  "content_feedback",
  "overall_feedback"
] as const;

const LANGUAGE_EDIT_KEYS = [
  "edit_id",
  "start",
  "end",
  "original_text",
  "replacement_text",
  "category",
  "severity",
  "explanation"
] as const;

const RAW_LANGUAGE_EDIT_KEYS = [
  "edit_id",
  "original_text",
  "replacement_text",
  "category",
  "severity",
  "explanation"
] as const;

const SCORE_KEYS = ["rubric_score", "rationale"] as const;
const CONTENT_FEEDBACK_KEYS = [
  "feedback_id",
  "category",
  "issue",
  "suggestion",
  "example"
] as const;

const EMAIL_RUBRIC_ANALYSIS_KEYS = [
  "communicative_purpose_and_elaboration",
  "syntax_and_word_choice",
  "social_conventions",
  "lexical_and_grammatical_control"
] as const;

const ACADEMIC_DISCUSSION_RUBRIC_ANALYSIS_KEYS = [
  "relevance_and_elaboration",
  "syntax_and_word_choice",
  "lexical_and_grammatical_control"
] as const;

export class AIReviewValidationError extends Error {
  issues: AIReviewValidationIssue[];

  constructor(issues: AIReviewValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "AIReviewValidationError";
    this.issues = issues;
  }
}

/** Validates the model result itself, including strict object shapes and task-specific fields. */
export function validateAIReviewResult(value: unknown): AIReviewValidationResult {
  return validateReviewResult(value, false) as AIReviewValidationResult;
}

/** Validates the strict model-facing result, whose edits never contain offsets. */
export function validateAIReviewRawResult(value: unknown): AIReviewRawValidationResult {
  return validateReviewResult(value, true) as AIReviewRawValidationResult;
}

function validateReviewResult(
  value: unknown,
  rawLanguageEdits: boolean
): AIReviewValidationResult | AIReviewRawValidationResult {
  const issues: AIReviewValidationIssue[] = [];
  const review = validateStrictObject(value, "$", TOP_LEVEL_KEYS, issues);

  if (!review) return { success: false, issues };

  if (review.schema_version !== AI_REVIEW_SCHEMA_VERSION) {
    addIssue(issues, "$.schema_version", 'must equal "1.0"');
  }

  const taskType = review.task_type;
  if (taskType !== "email" && taskType !== "academic_discussion") {
    addIssue(issues, "$.task_type", 'must be "email" or "academic_discussion"');
  }

  validateLanguageEdits(review.language_edits, issues, rawLanguageEdits);
  validateScore(review.score, issues);

  if (taskType === "email") {
    validateRubricAnalysis(
      review.rubric_analysis,
      EMAIL_RUBRIC_ANALYSIS_KEYS,
      issues
    );
    validateContentFeedback(
      review.content_feedback,
      EMAIL_CONTENT_FEEDBACK_CATEGORIES,
      issues
    );
  } else if (taskType === "academic_discussion") {
    validateRubricAnalysis(
      review.rubric_analysis,
      ACADEMIC_DISCUSSION_RUBRIC_ANALYSIS_KEYS,
      issues
    );
    validateContentFeedback(
      review.content_feedback,
      ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES,
      issues
    );
  } else {
    validateArray(review.content_feedback, "$.content_feedback", issues);
    validateObject(review.rubric_analysis, "$.rubric_analysis", issues);
  }

  validateNonEmptyString(review.overall_feedback, "$.overall_feedback", issues);

  return issues.length > 0
    ? { success: false, issues }
    : rawLanguageEdits
      ? { success: true, data: review as AIReviewRawResult }
      : { success: true, data: review as AIReviewResult };
}

/**
 * Validates the result and every edit against the original, unmodified response.
 * Offsets are never repaired or inferred from a fuzzy text search.
 */
export function validateAIReviewResultForResponse(
  value: unknown,
  responseText: string
): AIReviewValidationResult {
  const validation = validateAIReviewResult(value);
  if (!validation.success) return validation;

  const issues: AIReviewValidationIssue[] = [];
  validation.data.language_edits.forEach((edit, index) => {
    if (edit.end > responseText.length) {
      addIssue(
        issues,
        `$.language_edits[${index}].end`,
        "must not exceed response_text.length"
      );
    }

    if (responseText.slice(edit.start, edit.end) !== edit.original_text) {
      addIssue(
        issues,
        `$.language_edits[${index}].original_text`,
        "must exactly equal response_text.slice(start, end)"
      );
    }
  });

  const orderedEdits = validation.data.language_edits
    .map((edit, index) => ({ edit, index }))
    .sort((left, right) =>
      left.edit.start - right.edit.start || left.edit.end - right.edit.end
    );
  for (let index = 1; index < orderedEdits.length; index += 1) {
    const previous = orderedEdits[index - 1];
    const current = orderedEdits[index];
    if (current.edit.start < previous.edit.end) {
      addIssue(
        issues,
        `$.language_edits[${current.index}].start`,
        `must not overlap language_edits[${previous.index}]`
      );
    }
  }

  return issues.length > 0 ? { success: false, issues } : validation;
}

export function parseAIReviewResult(value: unknown): AIReviewResult {
  const validation = validateAIReviewResult(value);
  if (!validation.success) throw new AIReviewValidationError(validation.issues);
  return validation.data;
}

export function parseAIReviewResultForResponse(
  value: unknown,
  responseText: string
): AIReviewResult {
  const validation = validateAIReviewResultForResponse(value, responseText);
  if (!validation.success) throw new AIReviewValidationError(validation.issues);
  return validation.data;
}

export function parseAIReviewRawResult(value: unknown): AIReviewRawResult {
  const validation = validateAIReviewRawResult(value);
  if (!validation.success) throw new AIReviewValidationError(validation.issues);
  return validation.data;
}

/**
 * Converts a validated model-facing result into the internal result. Each original_text
 * must occur exactly once in the unmodified response; no fuzzy or normalized matching
 * is attempted.
 */
export function parseAIReviewRawResultForResponse(
  value: unknown,
  responseText: string
): AIReviewResult {
  const rawReview = parseAIReviewRawResult(value);
  const issues: AIReviewValidationIssue[] = [];
  const languageEdits = rawReview.language_edits.map((edit, index) => {
    const start = responseText.indexOf(edit.original_text);
    const path = `$.language_edits[${index}].original_text`;
    if (start < 0) {
      addIssue(issues, path, "must occur exactly in response_text");
      return { ...edit, start: 0, end: edit.original_text.length };
    }

    const nextStart = responseText.indexOf(edit.original_text, start + 1);
    if (nextStart >= 0) {
      addIssue(issues, path, "must occur exactly once in response_text");
    }
    return { ...edit, start, end: start + edit.original_text.length };
  });

  if (issues.length > 0) throw new AIReviewValidationError(issues);

  return parseAIReviewResultForResponse(
    { ...rawReview, language_edits: languageEdits },
    responseText
  );
}

function validateLanguageEdits(
  value: unknown,
  issues: AIReviewValidationIssue[],
  rawLanguageEdits: boolean
) {
  const edits = validateArray(value, "$.language_edits", issues);
  if (!edits) return;

  const editIds = new Set<string>();
  edits.forEach((item, index) => {
    const path = `$.language_edits[${index}]`;
    const edit = validateStrictObject(
      item,
      path,
      rawLanguageEdits ? RAW_LANGUAGE_EDIT_KEYS : LANGUAGE_EDIT_KEYS,
      issues
    );
    if (!edit) return;

    validateUniqueId(edit.edit_id, `${path}.edit_id`, editIds, issues);
    if (!rawLanguageEdits) {
      const startIsValid = validateNonNegativeInteger(edit.start, `${path}.start`, issues);
      const endIsValid = validateNonNegativeInteger(edit.end, `${path}.end`, issues);
      if (startIsValid && endIsValid && (edit.end as number) <= (edit.start as number)) {
        addIssue(issues, `${path}.end`, "must be greater than start");
      }
    }
    validateNonEmptyString(edit.original_text, `${path}.original_text`, issues);
    validateString(edit.replacement_text, `${path}.replacement_text`, issues);
    validateEnum(edit.category, LANGUAGE_EDIT_CATEGORIES, `${path}.category`, issues);
    validateEnum(edit.severity, LANGUAGE_EDIT_SEVERITIES, `${path}.severity`, issues);
    validateNonEmptyString(edit.explanation, `${path}.explanation`, issues);
  });
}

function validateScore(value: unknown, issues: AIReviewValidationIssue[]) {
  const score = validateStrictObject(value, "$.score", SCORE_KEYS, issues);
  if (!score) return;

  if (
    typeof score.rubric_score !== "number" ||
    !Number.isInteger(score.rubric_score) ||
    score.rubric_score < 0 ||
    score.rubric_score > 5
  ) {
    addIssue(issues, "$.score.rubric_score", "must be an integer from 0 through 5");
  }
  validateNonEmptyString(score.rationale, "$.score.rationale", issues);
}

function validateRubricAnalysis(
  value: unknown,
  keys: readonly string[],
  issues: AIReviewValidationIssue[]
) {
  const analysis = validateStrictObject(value, "$.rubric_analysis", keys, issues);
  if (!analysis) return;
  keys.forEach((key) =>
    validateNonEmptyString(analysis[key], `$.rubric_analysis.${key}`, issues)
  );
}

function validateContentFeedback(
  value: unknown,
  categories: readonly string[],
  issues: AIReviewValidationIssue[]
) {
  const feedbackItems = validateArray(value, "$.content_feedback", issues);
  if (!feedbackItems) return;

  const feedbackIds = new Set<string>();
  feedbackItems.forEach((item, index) => {
    const path = `$.content_feedback[${index}]`;
    const feedback = validateStrictObject(item, path, CONTENT_FEEDBACK_KEYS, issues);
    if (!feedback) return;

    validateUniqueId(feedback.feedback_id, `${path}.feedback_id`, feedbackIds, issues);
    validateEnum(feedback.category, categories, `${path}.category`, issues);
    validateNonEmptyString(feedback.issue, `${path}.issue`, issues);
    validateNonEmptyString(feedback.suggestion, `${path}.suggestion`, issues);
    validateString(feedback.example, `${path}.example`, issues);
  });
}

function validateUniqueId(
  value: unknown,
  path: string,
  seen: Set<string>,
  issues: AIReviewValidationIssue[]
) {
  if (!validateNonEmptyString(value, path, issues)) return;
  if (seen.has(value)) {
    addIssue(issues, path, "must be unique within this review");
    return;
  }
  seen.add(value);
}

function validateStrictObject(
  value: unknown,
  path: string,
  keys: readonly string[],
  issues: AIReviewValidationIssue[]
): Record<string, unknown> | null {
  const object = validateObject(value, path, issues);
  if (!object) return null;

  const allowedKeys = new Set(keys);
  keys.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      addIssue(issues, `${path}.${key}`, "is required");
    }
  });
  Object.keys(object).forEach((key) => {
    if (!allowedKeys.has(key)) addIssue(issues, `${path}.${key}`, "is not allowed");
  });
  return object;
}

function validateObject(
  value: unknown,
  path: string,
  issues: AIReviewValidationIssue[]
): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    addIssue(issues, path, "must be an object");
    return null;
  }
  return value as Record<string, unknown>;
}

function validateArray(
  value: unknown,
  path: string,
  issues: AIReviewValidationIssue[]
): unknown[] | null {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "must be an array");
    return null;
  }
  return value;
}

function validateString(
  value: unknown,
  path: string,
  issues: AIReviewValidationIssue[]
): value is string {
  if (typeof value !== "string") {
    addIssue(issues, path, "must be a string");
    return false;
  }
  return true;
}

function validateNonEmptyString(
  value: unknown,
  path: string,
  issues: AIReviewValidationIssue[]
): value is string {
  if (!validateString(value, path, issues)) return false;
  if (value.length === 0) {
    addIssue(issues, path, "must not be empty");
    return false;
  }
  return true;
}

function validateNonNegativeInteger(
  value: unknown,
  path: string,
  issues: AIReviewValidationIssue[]
): value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    addIssue(issues, path, "must be a non-negative integer");
    return false;
  }
  return true;
}

function validateEnum(
  value: unknown,
  allowedValues: readonly string[],
  path: string,
  issues: AIReviewValidationIssue[]
) {
  if (typeof value !== "string" || !allowedValues.includes(value)) {
    addIssue(issues, path, `must be one of: ${allowedValues.join(", ")}`);
  }
}

function addIssue(
  issues: AIReviewValidationIssue[],
  path: string,
  message: string
) {
  issues.push({ path, message });
}

const nonEmptyStringSchema = { type: "string", minLength: 1 } as const;

const languageEditJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: LANGUAGE_EDIT_KEYS,
  properties: {
    edit_id: nonEmptyStringSchema,
    start: { type: "integer", minimum: 0 },
    end: { type: "integer", minimum: 1 },
    original_text: nonEmptyStringSchema,
    replacement_text: { type: "string" },
    category: { type: "string", enum: LANGUAGE_EDIT_CATEGORIES },
    severity: { type: "string", enum: LANGUAGE_EDIT_SEVERITIES },
    explanation: nonEmptyStringSchema
  }
} as const;

const rawLanguageEditJsonSchema = {
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

const scoreJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: SCORE_KEYS,
  properties: {
    rubric_score: { type: "integer", minimum: 0, maximum: 5 },
    rationale: nonEmptyStringSchema
  }
} as const;

function rubricAnalysisJsonSchema(keys: readonly string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: keys,
    properties: Object.fromEntries(keys.map((key) => [key, nonEmptyStringSchema]))
  } as const;
}

function contentFeedbackJsonSchema(categories: readonly string[]) {
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: CONTENT_FEEDBACK_KEYS,
      properties: {
        feedback_id: nonEmptyStringSchema,
        category: { type: "string", enum: categories },
        issue: nonEmptyStringSchema,
        suggestion: nonEmptyStringSchema,
        example: { type: "string" }
      }
    }
  } as const;
}

function taskReviewJsonSchema(
  taskType: WritingTaskType,
  rubricAnalysisKeys: readonly string[],
  feedbackCategories: readonly string[],
  editSchema: typeof languageEditJsonSchema | typeof rawLanguageEditJsonSchema
) {
  return {
    type: "object",
    additionalProperties: false,
    required: TOP_LEVEL_KEYS,
    properties: {
      schema_version: { type: "string", const: AI_REVIEW_SCHEMA_VERSION },
      task_type: { type: "string", const: taskType },
      language_edits: { type: "array", items: editSchema },
      score: scoreJsonSchema,
      rubric_analysis: rubricAnalysisJsonSchema(rubricAnalysisKeys),
      content_feedback: contentFeedbackJsonSchema(feedbackCategories),
      overall_feedback: nonEmptyStringSchema
    }
  } as const;
}

/** Strict internal-result JSON Schema, including resolved offsets. */
export const AI_REVIEW_RESULT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "AIReviewResult",
  description:
    "Structured TOEFL writing review using one holistic 0-5 official rubric score.",
  oneOf: [
    taskReviewJsonSchema(
      "email",
      EMAIL_RUBRIC_ANALYSIS_KEYS,
      EMAIL_CONTENT_FEEDBACK_CATEGORIES,
      languageEditJsonSchema
    ),
    taskReviewJsonSchema(
      "academic_discussion",
      ACADEMIC_DISCUSSION_RUBRIC_ANALYSIS_KEYS,
      ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES,
      languageEditJsonSchema
    )
  ]
} as const;

/** Strict model-facing JSON Schema. Offsets are resolved only by server code. */
export const AI_REVIEW_RAW_RESULT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "AIReviewRawResult",
  description:
    "Model-facing structured TOEFL writing review without client-computed text offsets.",
  oneOf: [
    taskReviewJsonSchema(
      "email",
      EMAIL_RUBRIC_ANALYSIS_KEYS,
      EMAIL_CONTENT_FEEDBACK_CATEGORIES,
      rawLanguageEditJsonSchema
    ),
    taskReviewJsonSchema(
      "academic_discussion",
      ACADEMIC_DISCUSSION_RUBRIC_ANALYSIS_KEYS,
      ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES,
      rawLanguageEditJsonSchema
    )
  ]
} as const;
