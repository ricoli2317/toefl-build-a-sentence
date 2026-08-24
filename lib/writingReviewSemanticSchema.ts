import type { WritingTaskType } from "./writing.ts";
import type { WritingReviewTextUnit } from "./writingReviewTextUnits.ts";
import { findReadableExactTextOccurrences } from "./writingReviewTextMatch.ts";

export const WRITING_REVIEW_C3_SCHEMA_VERSION = "writing_review_c3_v5" as const;
export const WRITING_REVIEW_C3_SCHEMA_NAME = "tps_writing_review_c3_v5" as const;

export const WRITING_REVIEW_C3_DIMENSIONS = {
  email: [
    "communicative_purpose_and_elaboration",
    "syntactic_range_and_word_choice",
    "social_conventions",
    "lexical_and_grammatical_control"
  ],
  academic_discussion: [
    "relevance",
    "elaboration",
    "syntactic_range_and_word_choice",
    "lexical_and_grammatical_control"
  ]
} as const;

export const WRITING_REVIEW_C3_CONTENT_CATEGORIES = {
  email: [
    "communicative_purpose",
    "elaboration",
    "social_conventions",
    "organization"
  ],
  academic_discussion: [
    "relevance",
    "elaboration",
    "discussion_contribution",
    "organization"
  ]
} as const;

export const WRITING_REVIEW_C3_LANGUAGE_CATEGORIES = [
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

export const WRITING_REVIEW_C3_LANGUAGE_SEVERITIES = [
  "major",
  "moderate",
  "minor"
] as const;

type DimensionKey =
  (typeof WRITING_REVIEW_C3_DIMENSIONS)[WritingTaskType][number];
type ContentCategory =
  (typeof WRITING_REVIEW_C3_CONTENT_CATEGORIES)[WritingTaskType][number];
type LanguageCategory =
  (typeof WRITING_REVIEW_C3_LANGUAGE_CATEGORIES)[number];
type LanguageSeverity =
  (typeof WRITING_REVIEW_C3_LANGUAGE_SEVERITIES)[number];

export type WritingReviewSemanticC3 = {
  official_score: number;
  score_reason: string;
  overall_feedback: string;
  dimension_scores: Record<DimensionKey, { score: number; basis: string }>;
  unit_revisions: Array<{
    unit_id: string;
    original_text: string;
    replacement_text: string;
    reason: string;
    issue_type: LanguageCategory;
    severity: LanguageSeverity;
  }>;
  content_feedback: Array<{
    unit_id: string | null;
    category: ContentCategory;
    issue: string;
    suggestion: string;
    proposed_revision?: string;
  }>;
};

const nonEmptyString = { type: "string", minLength: 1 } as const;
const anyString = { type: "string" } as const;
const dimension = {
  type: "object",
  additionalProperties: false,
  required: ["score", "basis"],
  properties: {
    score: { type: "integer", minimum: 0, maximum: 5 },
    basis: nonEmptyString
  }
} as const;

export function writingReviewC3JsonSchema(taskType: WritingTaskType) {
  const dimensions = WRITING_REVIEW_C3_DIMENSIONS[taskType];
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "official_score",
      "score_reason",
      "overall_feedback",
      "dimension_scores",
      "unit_revisions",
      "content_feedback"
    ],
    properties: {
      official_score: { type: "integer", minimum: 0, maximum: 5 },
      score_reason: nonEmptyString,
      overall_feedback: nonEmptyString,
      dimension_scores: {
        type: "object",
        additionalProperties: false,
        required: [...dimensions],
        properties: Object.fromEntries(
          dimensions.map((key) => [key, dimension])
        )
      },
      unit_revisions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "unit_id",
            "original_text",
            "replacement_text",
            "reason",
            "issue_type",
            "severity"
          ],
          properties: {
            unit_id: { type: "string", pattern: "^U[0-9]{2}$" },
            original_text: nonEmptyString,
            replacement_text: anyString,
            reason: nonEmptyString,
            issue_type: {
              type: "string",
              enum: [...WRITING_REVIEW_C3_LANGUAGE_CATEGORIES]
            },
            severity: {
              type: "string",
              enum: [...WRITING_REVIEW_C3_LANGUAGE_SEVERITIES]
            }
          }
        }
      },
      content_feedback: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "unit_id",
            "category",
            "issue",
            "suggestion",
            "proposed_revision"
          ],
          properties: {
            unit_id: { type: "string", pattern: "^U[0-9]{2}$" },
            category: {
              type: "string",
              enum: [...WRITING_REVIEW_C3_CONTENT_CATEGORIES[taskType]]
            },
            issue: nonEmptyString,
            suggestion: nonEmptyString,
            proposed_revision: nonEmptyString
          }
        }
      }
    }
  } as const;
}

/** Compatibility alias for callers that only need an Email-shaped schema. */
export const WRITING_REVIEW_C3_JSON_SCHEMA = writingReviewC3JsonSchema("email");

export type WritingReviewC3ValidationDiagnostic = {
  path: string;
  code: string;
};

export class WritingReviewC3ValidationError extends Error {
  code:
    | "C3_SCHEMA_INVALID"
    | "C3_SCORE_CONTRACT_INVALID"
    | "C3_UNIT_VALIDATION_FAILED"
    | "C3_ANCHOR_LEAKAGE";
  diagnostics: WritingReviewC3ValidationDiagnostic[];

  constructor(
    code: WritingReviewC3ValidationError["code"],
    message: string,
    diagnostics: WritingReviewC3ValidationDiagnostic[]
  ) {
    super(message);
    this.name = "WritingReviewC3ValidationError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

function invalid(
  code: WritingReviewC3ValidationError["code"],
  path: string,
  message: string
): never {
  throw new WritingReviewC3ValidationError(code, message, [{ path, code }]);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string
) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalid(
      "C3_SCHEMA_INVALID",
      path,
      "C3 response contains missing or additional fields."
    );
  }
}

function nonEmpty(value: unknown, path: string) {
  if (typeof value !== "string" || !value.trim()) {
    invalid(
      "C3_SCHEMA_INVALID",
      path,
      "C3 response contains an empty required string."
    );
  }
  return value;
}

function noAnchor(value: string, path: string) {
  if (/⟦TPS_|TPS_UNIT:|TPS_INTERNAL_/.test(value)) {
    invalid(
      "C3_ANCHOR_LEAKAGE",
      path,
      "C3 response leaked an internal anchor."
    );
  }
}

function chineseExplanation(value: string, path: string) {
  if (!/[\u3400-\u9fff]/.test(value)) {
    invalid(
      "C3_SCHEMA_INVALID",
      path,
      "C3 explanatory feedback must be written in Chinese."
    );
  }
}

function wordCharacter(value: string | undefined) {
  return Boolean(value && /[A-Za-z0-9]/.test(value));
}

function validateReadableOriginal(
  originalText: string,
  unit: WritingReviewTextUnit,
  path: string
) {
  if (originalText !== originalText.trim()) {
    invalid(
      "C3_UNIT_VALIDATION_FAILED",
      path,
      "C3 language revision source must not have boundary whitespace."
    );
  }
  const occurrences = findReadableExactTextOccurrences(unit.text, originalText);
  const first = occurrences[0] ?? -1;
  if (occurrences.length !== 1) {
    invalid(
      "C3_UNIT_VALIDATION_FAILED",
      path,
      "C3 language revision source must occur exactly once as a readable span in its unit."
    );
  }
  const before = first > 0 ? unit.text[first - 1] : undefined;
  const after =
    first + originalText.length < unit.text.length
      ? unit.text[first + originalText.length]
      : undefined;
  if (
    (wordCharacter(before) && wordCharacter(originalText[0])) ||
    (wordCharacter(originalText.at(-1)) && wordCharacter(after))
  ) {
    invalid(
      "C3_UNIT_VALIDATION_FAILED",
      path,
      "C3 language revision source splits a word."
    );
  }
  if (!/[A-Za-z0-9]/.test(originalText)) {
    invalid(
      "C3_UNIT_VALIDATION_FAILED",
      path,
      "C3 language revision source must be a readable word or phrase."
    );
  }
  return { start: first, end: first + originalText.length };
}

export function parseWritingReviewC3Json(content: string): unknown {
  const input = content.replace(/^\uFEFF/, "").trim();
  const fenced = input.match(
    /^```(?:json)?[ \t]*\r?\n?([\s\S]*?)\r?\n?```$/i
  );
  const json = fenced ? fenced[1].trim() : input;
  if (
    !json ||
    (!fenced && /```/.test(json)) ||
    (fenced && /```/.test(fenced[1]))
  ) {
    throw Object.assign(
      new Error("C3 response is not one complete JSON value."),
      { code: "C3_INVALID_JSON" }
    );
  }
  try {
    return JSON.parse(json);
  } catch (cause) {
    throw Object.assign(new Error("C3 response is invalid JSON."), {
      code: "C3_INVALID_JSON",
      cause
    });
  }
}

export function parseWritingReviewSemanticC3(
  content: string,
  taskType: WritingTaskType,
  units: WritingReviewTextUnit[],
  options: { legacyV2?: boolean } = {}
): WritingReviewSemanticC3 {
  const value = parseWritingReviewC3Json(content);
  if (!record(value)) {
    invalid("C3_SCHEMA_INVALID", "$", "C3 response must be an object.");
  }
  exactKeys(
    value,
    [
      "official_score",
      "score_reason",
      "overall_feedback",
      "dimension_scores",
      "unit_revisions",
      "content_feedback"
    ],
    "$"
  );
  if (
    !Number.isInteger(value.official_score) ||
    (value.official_score as number) < 0 ||
    (value.official_score as number) > 5
  ) {
    invalid(
      "C3_SCHEMA_INVALID",
      "$.official_score",
      "C3 official score is invalid."
    );
  }

  const scoreReason = nonEmpty(value.score_reason, "$.score_reason");
  const overallFeedback = nonEmpty(
    value.overall_feedback,
    "$.overall_feedback"
  );
  noAnchor(scoreReason, "$.score_reason");
  noAnchor(overallFeedback, "$.overall_feedback");
  chineseExplanation(scoreReason, "$.score_reason");
  chineseExplanation(overallFeedback, "$.overall_feedback");

  if (!record(value.dimension_scores)) {
    invalid(
      "C3_SCHEMA_INVALID",
      "$.dimension_scores",
      "C3 dimension scores are invalid."
    );
  }
  const dimensionKeys = WRITING_REVIEW_C3_DIMENSIONS[taskType];
  exactKeys(value.dimension_scores, dimensionKeys, "$.dimension_scores");
  for (const key of dimensionKeys) {
    const item = value.dimension_scores[key];
    const path = `$.dimension_scores.${key}`;
    if (!record(item)) {
      invalid("C3_SCHEMA_INVALID", path, "C3 dimension is invalid.");
    }
    exactKeys(item, ["score", "basis"], path);
    if (
      !Number.isInteger(item.score) ||
      (item.score as number) < 0 ||
      (item.score as number) > 5
    ) {
      invalid(
        "C3_SCHEMA_INVALID",
        `${path}.score`,
        "C3 dimension score is invalid."
      );
    }
    if (
      (value.official_score === 0 && item.score !== 0) ||
      (value.official_score !== 0 &&
        ((item.score as number) < 1 || (item.score as number) > 5))
    ) {
      invalid(
        "C3_SCORE_CONTRACT_INVALID",
        `${path}.score`,
        "C3 official and dimension scores violate the score contract."
      );
    }
    const basis = nonEmpty(item.basis, `${path}.basis`);
    noAnchor(basis, `${path}.basis`);
    chineseExplanation(basis, `${path}.basis`);
  }

  if (!Array.isArray(value.unit_revisions)) {
    invalid(
      "C3_SCHEMA_INVALID",
      "$.unit_revisions",
      "C3 unit revisions are invalid."
    );
  }
  const unitById = new Map(units.map((unit) => [unit.unitId, unit]));
  const revisionRanges = new Map<string, Array<{ start: number; end: number }>>();
  for (const [index, item] of Array.from(value.unit_revisions.entries())) {
    const path = `$.unit_revisions[${index}]`;
    if (!record(item)) {
      invalid("C3_SCHEMA_INVALID", path, "C3 unit revision is invalid.");
    }
    exactKeys(
      item,
      [
        "unit_id",
        "original_text",
        "replacement_text",
        "reason",
        "issue_type",
        "severity"
      ],
      path
    );
    if (typeof item.unit_id !== "string" || !unitById.has(item.unit_id)) {
      invalid(
        "C3_UNIT_VALIDATION_FAILED",
        `${path}.unit_id`,
        "C3 unit ID is invalid."
      );
    }
    const originalText = nonEmpty(
      item.original_text,
      `${path}.original_text`
    );
    if (typeof item.replacement_text !== "string") {
      invalid(
        "C3_SCHEMA_INVALID",
        `${path}.replacement_text`,
        "C3 replacement text must be a string."
      );
    }
    if (
      item.replacement_text !== item.replacement_text.trim() ||
      /[\u3400-\u9fff]/.test(item.replacement_text) ||
      (item.replacement_text.length > 0 &&
        wordCharacter(originalText[0]) &&
        !wordCharacter(item.replacement_text[0]))
    ) {
      invalid(
        "C3_UNIT_VALIDATION_FAILED",
        `${path}.replacement_text`,
        "C3 replacement text must be directly applicable student-language text without boundary whitespace or a detached leading mark."
      );
    }
    const reason = nonEmpty(item.reason, `${path}.reason`);
    noAnchor(originalText, `${path}.original_text`);
    noAnchor(item.replacement_text, `${path}.replacement_text`);
    noAnchor(reason, `${path}.reason`);
    chineseExplanation(reason, `${path}.reason`);
    if (originalText === item.replacement_text) {
      invalid(
        "C3_UNIT_VALIDATION_FAILED",
        path,
        "C3 language revision must change the source text."
      );
    }
    if (
      typeof item.issue_type !== "string" ||
      !WRITING_REVIEW_C3_LANGUAGE_CATEGORIES.includes(
        item.issue_type as LanguageCategory
      )
    ) {
      invalid(
        "C3_SCHEMA_INVALID",
        `${path}.issue_type`,
        "C3 revision issue type is invalid."
      );
    }
    if (
      typeof item.severity !== "string" ||
      !WRITING_REVIEW_C3_LANGUAGE_SEVERITIES.includes(
        item.severity as LanguageSeverity
      )
    ) {
      invalid(
        "C3_SCHEMA_INVALID",
        `${path}.severity`,
        "C3 revision severity is invalid."
      );
    }
    const unit = unitById.get(item.unit_id)!;
    const range = validateReadableOriginal(
      originalText,
      unit,
      `${path}.original_text`
    );
    const ranges = revisionRanges.get(item.unit_id) ?? [];
    if (ranges.some((other) => range.start < other.end && range.end > other.start)) {
      invalid(
        "C3_UNIT_VALIDATION_FAILED",
        `${path}.original_text`,
        "C3 language revisions overlap within one unit."
      );
    }
    ranges.push(range);
    revisionRanges.set(item.unit_id, ranges);
  }

  if (!Array.isArray(value.content_feedback)) {
    invalid(
      "C3_SCHEMA_INVALID",
      "$.content_feedback",
      "C3 content feedback is invalid."
    );
  }
  const ids = new Set(units.map((unit) => unit.unitId));
  const categories = WRITING_REVIEW_C3_CONTENT_CATEGORIES[taskType];
  for (const [index, item] of Array.from(value.content_feedback.entries())) {
    const path = `$.content_feedback[${index}]`;
    if (!record(item)) {
      invalid("C3_SCHEMA_INVALID", path, "C3 content feedback item is invalid.");
    }
    const keys = Object.keys(item);
    const required = options.legacyV2
      ? ["unit_id", "category", "issue", "suggestion"]
      : ["unit_id", "category", "issue", "suggestion", "proposed_revision"];
    if (
      !keys.every((key) =>
        [
          "unit_id",
          "category",
          "issue",
          "suggestion",
          "proposed_revision"
        ].includes(key)
      ) ||
      !required.every((key) => key in item)
    ) {
      invalid(
        "C3_SCHEMA_INVALID",
        path,
        "C3 content feedback fields are invalid."
      );
    }
    if (
      (options.legacyV2 &&
        item.unit_id !== null &&
        (typeof item.unit_id !== "string" || !ids.has(item.unit_id))) ||
      (!options.legacyV2 &&
        (typeof item.unit_id !== "string" || !ids.has(item.unit_id)))
    ) {
      invalid(
        "C3_UNIT_VALIDATION_FAILED",
        `${path}.unit_id`,
        "C3 feedback unit ID is invalid."
      );
    }
    if (
      typeof item.category !== "string" ||
      !(categories as readonly string[]).includes(item.category)
    ) {
      invalid(
        "C3_SCHEMA_INVALID",
        `${path}.category`,
        "C3 content feedback category is invalid."
      );
    }
    for (const key of ["issue", "suggestion", "proposed_revision"] as const) {
      if (item[key] !== undefined) {
        const text = nonEmpty(item[key], `${path}.${key}`);
        noAnchor(text, `${path}.${key}`);
        if (key !== "proposed_revision") {
          chineseExplanation(text, `${path}.${key}`);
        }
      }
    }
  }

  return value as WritingReviewSemanticC3;
}
