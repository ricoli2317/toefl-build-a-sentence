/**
 * Writing Correction semantic contract (v1).
 *
 * Deliberately independent of writing_review_c3_v5: a correction review has no
 * language edits or content feedback of its own, only per-issue resolution
 * states, newly introduced problems, and one holistic score.
 */

export const WRITING_CORRECTION_SCHEMA_NAME =
  "tps_writing_correction_review_v1" as const;
export const WRITING_CORRECTION_SCHEMA_VERSION =
  "writing_correction_review_v1" as const;

export const CORRECTION_STATUSES = [
  "resolved",
  "partially_resolved",
  "unresolved",
  "uncertain"
] as const;

/**
 * Must stay aligned with the published issue vocabulary this review consumes:
 * new problems are described with the same language categories as
 * original_language_edits[].category, plus the correction-only content
 * categories. Omitting spelling/word_form/usage/other made the model's correct
 * categorisation of a new misspelling fail validation.
 */
export const CORRECTION_NEW_ISSUE_TYPES = [
  "grammar",
  "spelling",
  "word_form",
  "word_choice",
  "syntax",
  "usage",
  "punctuation",
  "capitalization",
  "social_convention",
  "content_gap",
  "task_requirement",
  "logic",
  "organization",
  "other"
] as const;

export const CORRECTION_SEVERITIES = ["major", "moderate", "minor"] as const;
export const CORRECTION_SCORE_IMPACTS = [
  "none",
  "small",
  "moderate",
  "large"
] as const;

export const writingCorrectionReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "task_type",
    "issue_resolutions",
    "new_issues",
    "correction_score",
    "score_rationale",
    "resolution_summary",
    "score_change_explanation"
  ],
  properties: {
    task_type: { type: "string", enum: ["email", "academic_discussion"] },
    issue_resolutions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "issue_id",
          "issue_type",
          "status",
          "deletion_based",
          "evidence",
          "explanation"
        ],
        properties: {
          issue_id: { type: "string", minLength: 1 },
          issue_type: {
            type: "string",
            enum: ["language_edit", "content_feedback"]
          },
          status: { type: "string", enum: [...CORRECTION_STATUSES] },
          deletion_based: { type: "boolean" },
          evidence: { type: "string" },
          explanation: { type: "string", minLength: 1 }
        }
      }
    },
    new_issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "type",
          "severity",
          "evidence",
          "explanation",
          "score_impact"
        ],
        properties: {
          type: { type: "string", enum: [...CORRECTION_NEW_ISSUE_TYPES] },
          severity: { type: "string", enum: [...CORRECTION_SEVERITIES] },
          evidence: { type: "string", minLength: 1 },
          explanation: { type: "string", minLength: 1 },
          score_impact: {
            type: "string",
            enum: [...CORRECTION_SCORE_IMPACTS]
          }
        }
      }
    },
    correction_score: { type: "integer", minimum: 0, maximum: 5 },
    score_rationale: { type: "string", minLength: 1 },
    resolution_summary: { type: "string", minLength: 1 },
    score_change_explanation: { type: "string", minLength: 1 }
  }
} as const;

export type CorrectionResolutionStatus =
  (typeof CORRECTION_STATUSES)[number];

export type WritingCorrectionReview = {
  task_type: "email" | "academic_discussion";
  issue_resolutions: Array<{
    issue_id: string;
    issue_type: "language_edit" | "content_feedback";
    status: CorrectionResolutionStatus;
    deletion_based: boolean;
    evidence: string;
    explanation: string;
  }>;
  new_issues: Array<{
    type: (typeof CORRECTION_NEW_ISSUE_TYPES)[number];
    severity: (typeof CORRECTION_SEVERITIES)[number];
    evidence: string;
    explanation: string;
    score_impact: (typeof CORRECTION_SCORE_IMPACTS)[number];
  }>;
  correction_score: number;
  score_rationale: string;
  resolution_summary: string;
  score_change_explanation: string;
};

export type CorrectionValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  counts: Record<CorrectionResolutionStatus, number>;
  coveredIssueIds: string[];
  missingIssueIds: string[];
  unknownIssueIds: string[];
  duplicateIssueIds: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Bounded rendering of the value that failed validation. The persisted
 * AI log only receives the validation message, so including the received
 * literal is what makes a future failure diagnosable without storing the
 * whole provider response.
 */
function describeReceivedValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") {
    const clipped = value.length <= 80 ? value : `${value.slice(0, 77)}...`;
    return `string ${JSON.stringify(clipped)}`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `${typeof value} ${String(value)}`;
  }
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Structural validation plus strict original-issue coverage. Coverage is the
 * contract that matters most: every frozen issue exactly once, never a
 * fabricated or dropped id.
 */
export function validateWritingCorrectionReview(
  value: unknown,
  expectedIssueIds: readonly string[]
): CorrectionValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const counts: Record<CorrectionResolutionStatus, number> = {
    resolved: 0,
    partially_resolved: 0,
    unresolved: 0,
    uncertain: 0
  };
  const result: CorrectionValidationResult = {
    ok: false,
    errors,
    warnings,
    counts,
    coveredIssueIds: [],
    missingIssueIds: [],
    unknownIssueIds: [],
    duplicateIssueIds: []
  };
  if (!isObject(value)) {
    errors.push("root: not an object");
    return result;
  }
  const allowedRoot = new Set(
    writingCorrectionReviewJsonSchema.required as readonly string[]
  );
  for (const key of Object.keys(value)) {
    if (!allowedRoot.has(key)) errors.push(`root: unexpected field ${key}`);
  }
  if (value.task_type !== "email" && value.task_type !== "academic_discussion") {
    errors.push("task_type: invalid");
  }
  if (
    typeof value.correction_score !== "number" ||
    !Number.isInteger(value.correction_score) ||
    value.correction_score < 0 ||
    value.correction_score > 5
  ) {
    errors.push("correction_score: not an integer 0-5");
  }
  for (const field of [
    "score_rationale",
    "resolution_summary",
    "score_change_explanation"
  ] as const) {
    if (!isNonEmptyString(value[field])) errors.push(`${field}: missing`);
  }

  const seen = new Map<string, number>();
  if (!Array.isArray(value.issue_resolutions)) {
    errors.push("issue_resolutions: not an array");
  } else {
    value.issue_resolutions.forEach((item, index) => {
      const at = `issue_resolutions[${index}]`;
      if (!isObject(item)) {
        errors.push(`${at}: not an object`);
        return;
      }
      const issueId = item.issue_id;
      if (!isNonEmptyString(issueId)) {
        errors.push(`${at}.issue_id: missing`);
      } else {
        seen.set(issueId, (seen.get(issueId) ?? 0) + 1);
        result.coveredIssueIds.push(issueId);
      }
      if (item.issue_type !== "language_edit" && item.issue_type !== "content_feedback") {
        errors.push(
          `${at}.issue_type: invalid (received ${describeReceivedValue(item.issue_type)})`
        );
      }
      if (
        typeof item.status !== "string" ||
        !(CORRECTION_STATUSES as readonly string[]).includes(item.status)
      ) {
        errors.push(
          `${at}.status: invalid (received ${describeReceivedValue(item.status)})`
        );
      } else {
        counts[item.status as CorrectionResolutionStatus] += 1;
      }
      if (typeof item.deletion_based !== "boolean") {
        errors.push(
          `${at}.deletion_based: not boolean (received ${describeReceivedValue(item.deletion_based)})`
        );
      }
      if (typeof item.evidence !== "string") {
        errors.push(`${at}.evidence: not a string`);
      }
      if (!isNonEmptyString(item.explanation)) {
        errors.push(`${at}.explanation: missing`);
      }
    });
    const sameSet =
      result.coveredIssueIds.length === expectedIssueIds.length &&
      expectedIssueIds.every((id) => seen.has(id));
    if (sameSet && result.coveredIssueIds.join("|") !== expectedIssueIds.join("|")) {
      warnings.push("issue order differs from the supplied order");
    }
  }

  if (!Array.isArray(value.new_issues)) {
    errors.push("new_issues: not an array");
  } else {
    value.new_issues.forEach((item, index) => {
      const at = `new_issues[${index}]`;
      if (!isObject(item)) {
        errors.push(`${at}: not an object`);
        return;
      }
      if (
        typeof item.type !== "string" ||
        !(CORRECTION_NEW_ISSUE_TYPES as readonly string[]).includes(item.type)
      ) {
        errors.push(
          `${at}.type: invalid (received ${describeReceivedValue(item.type)})`
        );
      }
      if (
        typeof item.severity !== "string" ||
        !(CORRECTION_SEVERITIES as readonly string[]).includes(item.severity)
      ) {
        errors.push(
          `${at}.severity: invalid (received ${describeReceivedValue(item.severity)})`
        );
      }
      if (!isNonEmptyString(item.evidence)) {
        errors.push(`${at}.evidence: missing`);
      }
      if (!isNonEmptyString(item.explanation)) {
        errors.push(`${at}.explanation: missing`);
      }
      if (
        typeof item.score_impact !== "string" ||
        !(CORRECTION_SCORE_IMPACTS as readonly string[]).includes(item.score_impact)
      ) {
        errors.push(
          `${at}.score_impact: invalid (received ${describeReceivedValue(item.score_impact)})`
        );
      }
    });
  }

  const expected = new Set(expectedIssueIds);
  seen.forEach((count, id) => {
    if (count > 1) result.duplicateIssueIds.push(id);
    if (!expected.has(id)) result.unknownIssueIds.push(id);
  });
  result.missingIssueIds = expectedIssueIds.filter((id) => !seen.has(id));
  if (result.missingIssueIds.length > 0) {
    errors.push(`missing issue ids: ${result.missingIssueIds.join(",")}`);
  }
  if (result.unknownIssueIds.length > 0) {
    errors.push(`unknown issue ids: ${result.unknownIssueIds.join(",")}`);
  }
  if (result.duplicateIssueIds.length > 0) {
    errors.push(`duplicate issue ids: ${result.duplicateIssueIds.join(",")}`);
  }

  result.ok = errors.length === 0;
  return result;
}

/**
 * The existing production AD under-100-word policy, applied by the benchmark
 * program rather than by the prompt. The correction prompt returns the pure
 * rubric score; this mapping is recorded next to it so the policy's effect is
 * always visible and can be confirmed or dropped without editing the prompt.
 */
export const AD_UNDER_100_SCORE_MAP: Record<number, number> = {
  5: 4,
  4: 3,
  3: 2,
  2: 1,
  1: 1,
  0: 0
};

export function applyAdUnder100Policy(
  taskType: "email" | "academic_discussion",
  rubricScore: number,
  wordCount: number
) {
  if (taskType !== "academic_discussion") {
    return { applied: false, adjustedScore: rubricScore };
  }
  if (wordCount >= 100) {
    return { applied: false, adjustedScore: rubricScore };
  }
  return {
    applied: true,
    adjustedScore: AD_UNDER_100_SCORE_MAP[rubricScore] ?? rubricScore
  };
}
