import { AIReviewValidationError } from "./writingReviewSchema.ts";
import {
  AI_REVIEW_RAW_RESULT_V21_JSON_SCHEMA,
  parseAIReviewRawResultV21ForResponse,
  validateAIReviewRawResultV21,
  validateContentRevisionOverlap
} from "./writingReviewSchemaV21.ts";
import type { WritingTaskType } from "./writing.ts";
import type {
  DimensionScoreKey,
  InternalLanguageEditV2,
  RawReviewScoresV2,
  WritingReviewLocalizationDiagnosticContext,
  WorkingReviewScoresV2
} from "./writingReviewSchemaV2.ts";

export const AI_REVIEW_SCHEMA_VERSION_V22 = "2.2" as const;

export type RawContentFeedbackV22<Category extends string = string> = {
  feedback_id: string;
  category: Category;
  original_sentence: string;
  issue: string;
  suggestion: string;
  proposed_revision: string;
};

export type InternalContentFeedbackV22<Category extends string = string> =
  RawContentFeedbackV22<Category> & {
    start: number;
    end: number;
    included: boolean;
  };

export type AIReviewRawResultV22 = {
  schema_version: typeof AI_REVIEW_SCHEMA_VERSION_V22;
  task_type: WritingTaskType;
  language_edits: Array<{
    edit_id: string;
    original_text: string;
    replacement_text: string;
    category: string;
    severity: string;
    explanation: string;
  }>;
  scores: RawReviewScoresV2<DimensionScoreKey>;
  content_feedback: RawContentFeedbackV22[];
  overall_feedback: string;
};

export type AIReviewResultV22 = Omit<
  AIReviewRawResultV22,
  "language_edits" | "scores" | "content_feedback"
> & {
  language_edits: InternalLanguageEditV2[];
  scores: WorkingReviewScoresV2<DimensionScoreKey>;
  content_feedback: InternalContentFeedbackV22[];
};

export type AIReviewV22ValidationResult =
  | { success: true; data: AIReviewRawResultV22 }
  | { success: false; issues: Array<{ path: string; message: string }> };

const V22_FEEDBACK_KEYS = [
  "feedback_id",
  "category",
  "original_sentence",
  "issue",
  "suggestion",
  "proposed_revision"
] as const;

export function validateAIReviewRawResultV22(
  value: unknown
): AIReviewV22ValidationResult {
  const issues: Array<{ path: string; message: string }> = [];
  if (!isRecord(value)) {
    return { success: false, issues: [{ path: "$", message: "must be an object" }] };
  }
  if (value.schema_version !== AI_REVIEW_SCHEMA_VERSION_V22) {
    issues.push({ path: "$.schema_version", message: 'must equal "2.2"' });
  }
  const feedbackItems = Array.isArray(value.content_feedback)
    ? value.content_feedback
    : [];
  if (!Array.isArray(value.content_feedback)) {
    issues.push({ path: "$.content_feedback", message: "must be an array" });
  }
  feedbackItems.forEach((item, index) => {
    const path = `$.content_feedback[${index}]`;
    if (!isRecord(item)) {
      issues.push({ path, message: "must be an object" });
      return;
    }
    const expectedKeys = new Set<string>(V22_FEEDBACK_KEYS);
    for (const key of V22_FEEDBACK_KEYS) {
      if (!(key in item)) issues.push({ path: `${path}.${key}`, message: "is required" });
    }
    for (const key of Object.keys(item)) {
      if (!expectedKeys.has(key)) {
        issues.push({ path: `${path}.${key}`, message: "is not allowed" });
      }
    }
    if (
      typeof item.proposed_revision !== "string" ||
      item.proposed_revision.length === 0
    ) {
      issues.push({
        path: `${path}.proposed_revision`,
        message: "must be a non-empty string"
      });
    }
  });

  const compatibleValidation = validateAIReviewRawResultV21(toV21Compatible(value));
  if (!compatibleValidation.success) issues.push(...compatibleValidation.issues);
  return issues.length > 0
    ? { success: false, issues: deduplicateIssues(issues) }
    : { success: true, data: value as AIReviewRawResultV22 };
}

export function parseAIReviewRawResultV22(value: unknown): AIReviewRawResultV22 {
  const validation = validateAIReviewRawResultV22(value);
  if (!validation.success) throw new AIReviewValidationError(validation.issues);
  return validation.data;
}

export function parseAIReviewRawResultV22ForResponse(
  value: unknown,
  responseText: string,
  diagnosticContext?: WritingReviewLocalizationDiagnosticContext
): AIReviewResultV22 {
  const raw = parseAIReviewRawResultV22(value);
  const locatedV21 = parseAIReviewRawResultV21ForResponse(
    toV21Compatible(raw),
    responseText,
    diagnosticContext
  );
  const contentFeedback = locatedV21.content_feedback.map(
    ({ example: _legacyExample, ...feedback }) => feedback
  );
  validateContentRevisionOverlap(contentFeedback);
  return {
    ...raw,
    language_edits: locatedV21.language_edits,
    scores: locatedV21.scores as WorkingReviewScoresV2<DimensionScoreKey>,
    content_feedback: contentFeedback
  };
}

function toV21Compatible(value: Record<string, unknown> | AIReviewRawResultV22) {
  return {
    ...value,
    schema_version: "2.1",
    content_feedback: Array.isArray(value.content_feedback)
      ? value.content_feedback.map((item) =>
          isRecord(item) ? { ...item, example: "" } : item
        )
      : value.content_feedback
  };
}

function buildV22Schema() {
  const schema = JSON.parse(
    JSON.stringify(AI_REVIEW_RAW_RESULT_V21_JSON_SCHEMA)
  ) as Record<string, unknown> & {
    title: string;
    description: string;
    oneOf: Array<{
      properties: {
        schema_version: { const: string };
        content_feedback: {
          items: { required: string[]; properties: Record<string, unknown> };
        };
      };
    }>;
  };
  schema.title = "AIReviewRawResultV22";
  schema.description =
    "TOEFL Writing Review v2.2 with directly applicable revisions and no redundant example field.";
  schema.oneOf.forEach((branch) => {
    branch.properties.schema_version.const = AI_REVIEW_SCHEMA_VERSION_V22;
    const feedback = branch.properties.content_feedback.items;
    feedback.required = feedback.required.filter((key) => key !== "example");
    delete feedback.properties.example;
  });
  return schema;
}

export const AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA = buildV22Schema();

function deduplicateIssues(issues: Array<{ path: string; message: string }>) {
  const seen = new Set<string>();
  return issues.filter((item) => {
    const key = `${item.path}:${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
