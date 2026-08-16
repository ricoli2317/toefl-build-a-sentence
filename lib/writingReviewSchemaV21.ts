import type { WritingTaskType } from "./writing.ts";
import { AIReviewValidationError } from "./writingReviewSchema.ts";
import {
  AI_REVIEW_RAW_RESULT_V2_JSON_SCHEMA,
  parseAIReviewRawResultV2ForResponse,
  validateAIReviewRawResultV2,
  type DimensionScoreKey,
  type InternalLanguageEditV2,
  type RawReviewScoresV2,
  type WritingReviewLocalizationDiagnosticContext,
  type WorkingReviewScoresV2
} from "./writingReviewSchemaV2.ts";

export const AI_REVIEW_SCHEMA_VERSION_V21 = "2.1" as const;

export type RawContentFeedbackV21<Category extends string = string> = {
  feedback_id: string;
  category: Category;
  original_sentence: string;
  issue: string;
  suggestion: string;
  example: string;
  proposed_revision: string;
};

export type InternalContentFeedbackV21<Category extends string = string> =
  RawContentFeedbackV21<Category> & {
    start: number;
    end: number;
    included: boolean;
  };

export type AIReviewRawResultV21 = {
  schema_version: typeof AI_REVIEW_SCHEMA_VERSION_V21;
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
  content_feedback: RawContentFeedbackV21[];
  overall_feedback: string;
};

export type AIReviewResultV21 = Omit<
  AIReviewRawResultV21,
  "language_edits" | "scores" | "content_feedback"
> & {
  language_edits: InternalLanguageEditV2[];
  scores: WorkingReviewScoresV2<DimensionScoreKey>;
  content_feedback: InternalContentFeedbackV21[];
};

export type AIReviewV21ValidationResult =
  | { success: true; data: AIReviewRawResultV21 }
  | { success: false; issues: Array<{ path: string; message: string }> };

const V21_FEEDBACK_KEYS = [
  "feedback_id",
  "category",
  "original_sentence",
  "issue",
  "suggestion",
  "example",
  "proposed_revision"
] as const;

export function validateAIReviewRawResultV21(
  value: unknown
): AIReviewV21ValidationResult {
  const issues: Array<{ path: string; message: string }> = [];
  if (!isRecord(value)) {
    return { success: false, issues: [{ path: "$", message: "must be an object" }] };
  }
  if (value.schema_version !== AI_REVIEW_SCHEMA_VERSION_V21) {
    issues.push({ path: "$.schema_version", message: 'must equal "2.1"' });
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
    const actualKeys = Object.keys(item).sort();
    const expectedKeys = [...V21_FEEDBACK_KEYS].sort();
    expectedKeys.forEach((key) => {
      if (!(key in item)) issues.push({ path: `${path}.${key}`, message: "is required" });
    });
    actualKeys.forEach((key) => {
      if (!(expectedKeys as string[]).includes(key)) {
        issues.push({ path: `${path}.${key}`, message: "is not allowed" });
      }
    });
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

  const compatible = toV2Compatible(value);
  const v2Validation = validateAIReviewRawResultV2(compatible);
  if (!v2Validation.success) issues.push(...v2Validation.issues);
  return issues.length > 0
    ? { success: false, issues: deduplicateIssues(issues) }
    : { success: true, data: value as AIReviewRawResultV21 };
}

export function parseAIReviewRawResultV21(value: unknown): AIReviewRawResultV21 {
  const validation = validateAIReviewRawResultV21(value);
  if (!validation.success) throw new AIReviewValidationError(validation.issues);
  return validation.data;
}

export function parseAIReviewRawResultV21ForResponse(
  value: unknown,
  responseText: string,
  diagnosticContext?: WritingReviewLocalizationDiagnosticContext
): AIReviewResultV21 {
  const raw = parseAIReviewRawResultV21(value);
  const locatedV2 = parseAIReviewRawResultV2ForResponse(
    toV2Compatible(raw),
    responseText,
    diagnosticContext
  );
  const contentFeedback = locatedV2.content_feedback.map((feedback, index) => ({
    ...feedback,
    proposed_revision: raw.content_feedback[index].proposed_revision
  }));
  validateContentRevisionOverlap(contentFeedback);
  return {
    ...raw,
    language_edits: locatedV2.language_edits,
    scores: locatedV2.scores as WorkingReviewScoresV2<DimensionScoreKey>,
    content_feedback: contentFeedback
  };
}

export function validateContentRevisionOverlap(
  feedbackItems: Array<{ start: number; end: number; included?: boolean }>
) {
  const ordered = feedbackItems
    .map((feedback, index) => ({ feedback, index }))
    .filter(({ feedback }) => feedback.included !== false)
    .sort(
      (left, right) =>
        left.feedback.start - right.feedback.start ||
        left.feedback.end - right.feedback.end
    );
  const issues: Array<{ path: string; message: string }> = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.feedback.start < previous.feedback.end) {
      issues.push({
        path: `$.content_feedback[${current.index}].start`,
        message: `must not overlap content_feedback[${previous.index}]`
      });
    }
  }
  if (issues.length > 0) throw new AIReviewValidationError(issues);
}

function toV2Compatible(value: Record<string, unknown> | AIReviewRawResultV21) {
  const contentFeedback = Array.isArray(value.content_feedback)
    ? value.content_feedback.map((item) => {
        if (!isRecord(item)) return item;
        const { proposed_revision: _proposedRevision, ...compatibleItem } = item;
        return compatibleItem;
      })
    : value.content_feedback;
  return {
    ...value,
    schema_version: "2.0",
    content_feedback: contentFeedback
  };
}

function buildV21Schema() {
  const schema = JSON.parse(
    JSON.stringify(AI_REVIEW_RAW_RESULT_V2_JSON_SCHEMA)
  ) as Record<string, unknown> & {
    title: string;
    description: string;
    oneOf: Array<{
      properties: {
        schema_version: { const: string };
        content_feedback: {
          items: {
            required: string[];
            properties: Record<string, unknown>;
          };
        };
      };
    }>;
  };
  schema.title = "AIReviewRawResultV21";
  schema.description =
    "TOEFL Writing Review v2.1 with directly applicable sentence-level content revisions.";
  schema.oneOf.forEach((branch) => {
    branch.properties.schema_version.const = AI_REVIEW_SCHEMA_VERSION_V21;
    branch.properties.content_feedback.items.required.push("proposed_revision");
    branch.properties.content_feedback.items.properties.proposed_revision = {
      type: "string",
      minLength: 1
    };
  });
  return schema;
}

export const AI_REVIEW_RAW_RESULT_V21_JSON_SCHEMA = buildV21Schema();

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
