import {
  AI_REVIEW_SCHEMA_VERSION,
  AIReviewValidationError,
  LANGUAGE_EDIT_CATEGORIES,
  LANGUAGE_EDIT_SEVERITIES,
  parseAIReviewResultForResponse,
  type AIReviewResult,
  type ContentFeedback,
  type LanguageEdit,
  type RubricScore
} from "./writingReviewSchema.ts";
import {
  ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES_V2,
  ACADEMIC_DISCUSSION_DIMENSION_SCORE_KEYS,
  EMAIL_CONTENT_FEEDBACK_CATEGORIES_V2,
  EMAIL_DIMENSION_SCORE_KEYS,
  parseAIReviewRawResultV2,
  type DimensionScoreKey,
  type InternalContentFeedbackV2,
  type WorkingDimensionScoreV2,
  type WorkingOfficialScoreV2,
  type WorkingReviewScoresV2
} from "./writingReviewSchemaV2.ts";
import {
  parseAIReviewRawResultV21,
  validateContentRevisionOverlap,
  type InternalContentFeedbackV21
} from "./writingReviewSchemaV21.ts";
import {
  parseAIReviewRawResultV22,
  type InternalContentFeedbackV22
} from "./writingReviewSchemaV22.ts";
import type { WritingTaskType } from "./writing.ts";
import { allocatePersistedSplitEditExplanations } from "./writingReviewLanguageEditExplanation.ts";
import { normalizeC3LanguageEditParts } from "./writingReviewV22Assembler.ts";

export type WorkingReviewItemSource = "ai" | "teacher";
export const TEACHER_REVIEW_CONTENT_REQUIRED_MESSAGE =
  "请至少填写一项批改内容";
export type WorkingLanguageEdit = LanguageEdit & {
  restored: boolean;
  source?: WorkingReviewItemSource;
};
export type LegacyWorkingContentFeedbackItem = ContentFeedback<string> & {
  included: boolean;
};
export type WorkingContentFeedbackItem = (
  | LegacyWorkingContentFeedbackItem
  | InternalContentFeedbackV2<string>
  | InternalContentFeedbackV21<string>
  | InternalContentFeedbackV22<string>
) & { source?: WorkingReviewItemSource };

export type CompatibleWorkingReviewScores = {
  official_score: WorkingOfficialScoreV2;
  dimension_scores: Record<DimensionScoreKey, WorkingDimensionScoreV2> | null;
  /** Temporary type-only bridge until the separately scoped v2 UI update. */
  rubric_score?: RubricScore;
  rationale?: string;
};

export type WorkingContentFeedback = {
  rubric_analysis: AIReviewResult["rubric_analysis"] | Record<string, never>;
  items: WorkingContentFeedbackItem[];
  overall_feedback: string;
};

export type WritingReviewWorkingDraft = {
  language_edits: WorkingLanguageEdit[];
  scores: CompatibleWorkingReviewScores;
  content_feedback: WorkingContentFeedback;
  teacher_comment: string;
};

export type WritingReviewWorkspaceInput = {
  taskType: WritingTaskType;
  responseText: string;
  languageEdits: unknown;
  scores: unknown;
  contentFeedback: unknown;
  teacherComment: unknown;
};

export class WritingReviewWorkspaceValidationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "WritingReviewWorkspaceValidationError";
  }
}

const EMPTY_SCORE_REFERENCE_VALIDATION_TEXT = "评分依据留空。";
const EMPTY_OVERALL_FEEDBACK_VALIDATION_TEXT = "总体评价留空。";

export function buildManualWritingReviewDraft(
  taskType: WritingTaskType
): WritingReviewWorkingDraft {
  const dimensionKeys =
    taskType === "email"
      ? EMAIL_DIMENSION_SCORE_KEYS
      : ACADEMIC_DISCUSSION_DIMENSION_SCORE_KEYS;
  return {
    language_edits: [],
    scores: {
      official_score: {
        ai_score: 0,
        teacher_score: 0,
        rationale: ""
      },
      dimension_scores: Object.fromEntries(
        dimensionKeys.map((key) => [
          key,
          {
            ai_score: 0,
            teacher_score: 0,
            ai_basis: ""
          }
        ])
      ) as Record<DimensionScoreKey, WorkingDimensionScoreV2>
    },
    content_feedback: {
      rubric_analysis: {},
      items: [],
      overall_feedback: ""
    },
    teacher_comment: ""
  };
}

export function normalizeWritingReviewWorkingDraft(
  input: WritingReviewWorkspaceInput
): WritingReviewWorkingDraft {
  if (!Array.isArray(input.languageEdits)) {
    throw invalid("language_edits 必须是数组。");
  }
  if (!isRecord(input.contentFeedback) || !Array.isArray(input.contentFeedback.items)) {
    throw invalid("content_feedback 格式无效。");
  }
  if (typeof input.contentFeedback.overall_feedback !== "string") {
    throw invalid("content_feedback.overall_feedback 必须是字符串。");
  }
  if (typeof input.teacherComment !== "string") {
    throw invalid("teacher_comment 必须是字符串。");
  }

  const restoredFlags = input.languageEdits.map((value, index) => {
    if (!isRecord(value)) throw invalid(`language_edits[${index}] 格式无效。`);
    if ("restored" in value && typeof value.restored !== "boolean") {
      throw invalid(`language_edits[${index}].restored 必须是布尔值。`);
    }
    return value.restored === true;
  });
  const editSources = input.languageEdits.map(readWorkingItemSource);
  const includedFlags = input.contentFeedback.items.map((value, index) => {
    if (!isRecord(value)) throw invalid(`content_feedback.items[${index}] 格式无效。`);
    if ("included" in value && typeof value.included !== "boolean") {
      throw invalid(`content_feedback.items[${index}].included 必须是布尔值。`);
    }
    return value.included !== false;
  });
  const feedbackSources = input.contentFeedback.items.map(readWorkingItemSource);

  if (isLegacyV1Scores(input.scores) || isNormalizedLegacyV1Scores(input.scores)) {
    return normalizeLegacyV1WorkingDraft(
      input,
      restoredFlags,
      includedFlags,
      editSources,
      feedbackSources
    );
  }

  return normalizeV2WorkingDraft(
    input,
    restoredFlags,
    includedFlags,
    editSources,
    feedbackSources
  );
}

function normalizeLegacyV1WorkingDraft(
  input: WritingReviewWorkspaceInput,
  restoredFlags: boolean[],
  includedFlags: boolean[],
  editSources: WorkingReviewItemSource[],
  feedbackSources: WorkingReviewItemSource[]
): WritingReviewWorkingDraft {
  const languageEdits = input.languageEdits as unknown[];
  const contentFeedback = input.contentFeedback as Record<string, unknown> & {
    items: unknown[];
    overall_feedback: string;
  };
  const legacyScores = isLegacyV1Scores(input.scores)
    ? {
        official_score: {
          ai_score: input.scores.rubric_score,
          teacher_score: input.scores.rubric_score,
          rationale: input.scores.rationale
        },
        dimension_scores: null
      }
    : normalizeLegacyCompatibleScores(input.scores);
  const aiLanguageEdits = languageEdits.filter(
    (_item, index) => editSources[index] === "ai"
  );
  const aiFeedbackItems = contentFeedback.items.filter(
    (_item, index) => feedbackSources[index] === "ai"
  );
  let validated: AIReviewResult;
  try {
    validated = parseAIReviewResultForResponse(
      {
        schema_version: AI_REVIEW_SCHEMA_VERSION,
        task_type: input.taskType,
        language_edits: aiLanguageEdits.map(stripWorkingLanguageEdit),
        score: {
          rubric_score: legacyScores.official_score.teacher_score,
          rationale: scoreReferenceForValidation(
            legacyScores.official_score.rationale
          )
        },
        rubric_analysis: contentFeedback.rubric_analysis,
        content_feedback: aiFeedbackItems.map(stripWorkingFeedbackItem),
        overall_feedback: overallFeedbackForValidation(
          contentFeedback.overall_feedback
        )
      },
      input.responseText
    );
  } catch (error) {
    throw invalid(
      error instanceof AIReviewValidationError
        ? `批改工作稿校验失败：${error.message}`
        : "批改工作稿校验失败。",
      error
    );
  }

  let aiEditIndex = 0;
  const normalizedEdits = languageEdits.map((item, index) =>
    editSources[index] === "teacher"
      ? validateTeacherLanguageEdit(
          item,
          input.responseText,
          restoredFlags[index],
          index
        )
      : {
          ...validated.language_edits[aiEditIndex++],
          restored: restoredFlags[index],
          source: "ai" as const
        }
  );
  validateWorkingLanguageEditOverlap(normalizedEdits);
  let aiFeedbackIndex = 0;
  const normalizedFeedback = contentFeedback.items.map((item, index) =>
    feedbackSources[index] === "teacher"
      ? validateTeacherContentFeedback(
          item,
          input.taskType,
          input.responseText,
          includedFlags[index],
          index
        )
      : {
          ...validated.content_feedback[aiFeedbackIndex++],
          included: includedFlags[index],
          source: "ai" as const
        }
  );
  return {
    language_edits: normalizedEdits,
    scores: legacyScores,
    content_feedback: {
      rubric_analysis: validated.rubric_analysis,
      items: normalizedFeedback,
      overall_feedback: contentFeedback.overall_feedback as string
    },
    teacher_comment: input.teacherComment as string
  };
}

function normalizeV2WorkingDraft(
  input: WritingReviewWorkspaceInput,
  restoredFlags: boolean[],
  includedFlags: boolean[],
  editSources: WorkingReviewItemSource[],
  feedbackSources: WorkingReviewItemSource[]
): WritingReviewWorkingDraft {
  const scores = normalizeWorkingScoresV2(input.scores, input.taskType);
  const languageEdits = input.languageEdits as unknown[];
  const contentFeedback = input.contentFeedback as Record<string, unknown> & {
    items: unknown[];
    overall_feedback: string;
  };
  const aiFeedbackItems = contentFeedback.items.filter(
    (_item, index) => feedbackSources[index] === "ai"
  );
  const hasProposedRevision = aiFeedbackItems.length > 0 && aiFeedbackItems.every(
    (item) => isRecord(item) && typeof item.proposed_revision === "string"
  );
  const hasAnyProposedRevision = aiFeedbackItems.some(
    (item) => isRecord(item) && "proposed_revision" in item
  );
  if (hasAnyProposedRevision && !hasProposedRevision) {
    throw invalid("content_feedback v2.1/v2.2 必须为每条反馈提供 proposed_revision。");
  }
  const isV22 = hasProposedRevision && aiFeedbackItems.every(
    (item) => isRecord(item) && !("example" in item)
  );
  const isV21 = hasProposedRevision && !isV22;
  const aiLanguageEdits = languageEdits.filter(
    (_item, index) => editSources[index] === "ai"
  );
  const rawCandidate = {
    schema_version: isV22 ? "2.2" : isV21 ? "2.1" : "2.0",
    task_type: input.taskType,
    language_edits: aiLanguageEdits.map(stripWorkingLanguageEditForRawV2),
    scores: stripTeacherScores(scores),
    content_feedback: aiFeedbackItems.map(
      isV22
        ? stripWorkingFeedbackItemV22
        : isV21
          ? stripWorkingFeedbackItemV21
          : stripWorkingFeedbackItemV2
    ),
    overall_feedback: overallFeedbackForValidation(
      contentFeedback.overall_feedback
    )
  };

  let validatedRaw:
    | ReturnType<typeof parseAIReviewRawResultV2>
    | ReturnType<typeof parseAIReviewRawResultV21>
    | ReturnType<typeof parseAIReviewRawResultV22>;
  try {
    // A persisted working draft already contains verified source offsets. Do
    // not throw those offsets away and localize its text again: C3 anchors may
    // legitimately target the second occurrence of text that is repeated in
    // the full response. Validate the raw field contract here, then verify the
    // stored offset against the exact response slice below.
    validatedRaw = isV22
      ? parseAIReviewRawResultV22(rawCandidate)
      : isV21
        ? parseAIReviewRawResultV21(rawCandidate)
        : parseAIReviewRawResultV2(rawCandidate);
  } catch (error) {
    throw invalid(
      error instanceof AIReviewValidationError
        ? `批改工作稿校验失败：${error.message}`
        : "批改工作稿校验失败。",
      error
    );
  }

  let aiEditIndex = 0;
  const validatedEdits = languageEdits.map((inputEdit, index) => {
    if (editSources[index] === "teacher") {
      return validateTeacherLanguageEdit(
        inputEdit,
        input.responseText,
        restoredFlags[index],
        index
      );
    }
    const edit = validatedRaw.language_edits[aiEditIndex++];
    if (
      !edit ||
      !isRecord(inputEdit) ||
      !Number.isInteger(inputEdit.start) ||
      !Number.isInteger(inputEdit.end) ||
      (inputEdit.start as number) < 0 ||
      (inputEdit.end as number) <= (inputEdit.start as number) ||
      (inputEdit.end as number) > input.responseText.length ||
      input.responseText.slice(
        inputEdit.start as number,
        inputEdit.end as number
      ) !== edit.original_text
    ) {
      throw invalid(`language_edits[${index}] offset 无效。`);
    }
    return {
      edit_id: edit.edit_id,
      start: inputEdit.start as number,
      end: inputEdit.end as number,
      original_text: edit.original_text,
      replacement_text: edit.replacement_text,
      category: edit.category as WorkingLanguageEdit["category"],
      severity: edit.severity as WorkingLanguageEdit["severity"],
      explanation: edit.explanation,
      restored: restoredFlags[index],
      source: "ai" as const
    };
    });
  const normalizedEdits = allocatePersistedSplitEditExplanations(
    validatedEdits.flatMap((edit) =>
      edit.source === "ai" && /^c3-edit-\d+$/.test(edit.edit_id)
        ? normalizeC3LanguageEditParts(edit)
        : [edit]
    )
  );
  validateWorkingLanguageEditOverlap(normalizedEdits);

  let aiFeedbackIndex = 0;
  const normalizedItems = contentFeedback.items.map((inputFeedback, index) => {
    if (feedbackSources[index] === "teacher") {
      return validateTeacherContentFeedback(
        inputFeedback,
        input.taskType,
        input.responseText,
        includedFlags[index],
        index
      );
    }
    const feedback = validatedRaw.content_feedback[aiFeedbackIndex++];
    if (
      !feedback ||
      !isRecord(inputFeedback) ||
      !Number.isInteger(inputFeedback.start) ||
      !Number.isInteger(inputFeedback.end) ||
      (inputFeedback.start as number) < 0 ||
      (inputFeedback.end as number) <= (inputFeedback.start as number) ||
      (inputFeedback.end as number) > input.responseText.length ||
      input.responseText.slice(
        inputFeedback.start as number,
        inputFeedback.end as number
      ) !== feedback.original_sentence
    ) {
      throw invalid(`content_feedback.items[${index}] offset 无效。`);
    }
    return {
      ...feedback,
      start: inputFeedback.start as number,
      end: inputFeedback.end as number,
      included: includedFlags[index],
      source: "ai" as const
    };
  });
  if (hasProposedRevision) {
    try {
      validateContentRevisionOverlap(
        normalizedItems.flatMap((item) => {
          const value = item as unknown as Record<string, unknown>;
          return typeof value.proposed_revision === "string" &&
            value.proposed_revision.length > 0 &&
            typeof value.start === "number" &&
            typeof value.end === "number"
            ? [
                {
                  start: value.start,
                  end: value.end,
                  included: value.included === true
                }
              ]
            : [];
        })
      );
    } catch (error) {
      throw invalid("已采用的内容改写不能互相重叠。", error);
    }
  }
  return {
    language_edits: normalizedEdits,
    scores,
    content_feedback: {
      rubric_analysis: {},
      items: normalizedItems,
      overall_feedback: contentFeedback.overall_feedback as string
    },
    teacher_comment: input.teacherComment as string
  };
}

function normalizeWorkingScoresV2(
  value: unknown,
  taskType: WritingTaskType
): CompatibleWorkingReviewScores {
  if (!isRecord(value) || !isRecord(value.official_score) || !isRecord(value.dimension_scores)) {
    throw invalid("scores v2 格式无效。");
  }
  const official = value.official_score;
  assertExactKeys(official, ["ai_score", "teacher_score", "rationale"], "scores.official_score");
  assertScore(official.ai_score, "scores.official_score.ai_score");
  assertScore(official.teacher_score, "scores.official_score.teacher_score");
  if (typeof official.rationale !== "string") {
    throw invalid("scores.official_score.rationale 必须是字符串。");
  }

  const dimensionScores = value.dimension_scores;
  const dimensionKeys =
    taskType === "email"
      ? EMAIL_DIMENSION_SCORE_KEYS
      : ACADEMIC_DISCUSSION_DIMENSION_SCORE_KEYS;
  assertExactKeys(dimensionScores, dimensionKeys, "scores.dimension_scores");
  const dimensions: Record<string, WorkingDimensionScoreV2> = {};
  dimensionKeys.forEach((key) => {
    const dimension = dimensionScores[key];
    if (!isRecord(dimension)) throw invalid(`scores.dimension_scores.${key} 格式无效。`);
    assertExactKeys(
      dimension,
      ["ai_score", "teacher_score", "ai_basis"],
      `scores.dimension_scores.${key}`
    );
    assertScore(dimension.ai_score, `scores.dimension_scores.${key}.ai_score`);
    assertScore(dimension.teacher_score, `scores.dimension_scores.${key}.teacher_score`);
    if (typeof dimension.ai_basis !== "string") {
      throw invalid(`scores.dimension_scores.${key}.ai_basis 必须是字符串。`);
    }
    dimensions[key] = {
      ai_score: dimension.ai_score,
      teacher_score: dimension.teacher_score,
      ai_basis: dimension.ai_basis
    } as WorkingDimensionScoreV2;
  });

  return {
    official_score: {
      ai_score: official.ai_score as RubricScore,
      teacher_score: official.teacher_score as RubricScore,
      rationale: official.rationale
    },
    dimension_scores: dimensions as Record<DimensionScoreKey, WorkingDimensionScoreV2>
  };
}

export function buildWritingReviewSaveUpdate(draft: WritingReviewWorkingDraft) {
  return {
    language_edits: draft.language_edits,
    scores: draft.scores,
    content_feedback:
      draft.scores.dimension_scores === null
        ? draft.content_feedback
        : {
            items: draft.content_feedback.items,
            overall_feedback: draft.content_feedback.overall_feedback
          },
    teacher_comment: draft.teacher_comment
  };
}

export function buildWritingReviewPublishUpdate(
  draft: WritingReviewWorkingDraft,
  publishedAt: string
) {
  const working = buildWritingReviewSaveUpdate(draft);
  return {
    ...working,
    published_language_edits: draft.language_edits
      .filter((edit) => !edit.restored)
      .map(stripWorkingLanguageEdit),
    published_scores: draft.scores,
    published_content_feedback: {
      items: draft.content_feedback.items
        .filter((item) => item.included)
        .map(stripWorkingFeedbackItem),
      overall_feedback: draft.content_feedback.overall_feedback,
      ...(draft.scores.dimension_scores === null
        ? { rubric_analysis: draft.content_feedback.rubric_analysis }
        : {})
    },
    published_teacher_comment: draft.teacher_comment,
    status: "published" as const,
    published_at: publishedAt
  };
}

export type ReviewedTextSegment =
  | { kind: "text"; text: string }
  | { kind: "edit"; text: string; edit: WorkingLanguageEdit };

export function buildReviewedTextSegments(
  responseText: string,
  languageEdits: WorkingLanguageEdit[]
): ReviewedTextSegment[] {
  const edits = [...languageEdits].sort(
    (left, right) => left.start - right.start || left.end - right.end
  );
  const segments: ReviewedTextSegment[] = [];
  let cursor = 0;

  for (const edit of edits) {
    if (
      edit.start < cursor ||
      edit.end > responseText.length ||
      responseText.slice(edit.start, edit.end) !== edit.original_text
    ) {
      throw invalid("语言修改 offset 无效或发生重叠。");
    }
    if (edit.start > cursor) {
      segments.push({ kind: "text", text: responseText.slice(cursor, edit.start) });
    }
    segments.push({
      kind: "edit",
      text: edit.restored ? edit.original_text : edit.replacement_text,
      edit
    });
    cursor = edit.end;
  }

  if (cursor < responseText.length) {
    segments.push({ kind: "text", text: responseText.slice(cursor) });
  }
  return segments;
}

export function buildReviewedText(
  responseText: string,
  languageEdits: WorkingLanguageEdit[]
) {
  return buildReviewedTextSegments(responseText, languageEdits)
    .map((segment) => segment.text)
    .join("");
}

function stripWorkingLanguageEdit(value: unknown): LanguageEdit | unknown {
  if (!isRecord(value)) return value;
  return {
    edit_id: value.edit_id,
    start: value.start,
    end: value.end,
    original_text: value.original_text,
    replacement_text: value.replacement_text,
    category: value.category,
    severity: value.severity,
    explanation: value.explanation
  };
}

function stripWorkingLanguageEditForRawV2(value: unknown) {
  if (!isRecord(value)) return value;
  return {
    edit_id: value.edit_id,
    original_text: value.original_text,
    replacement_text: value.replacement_text,
    category: value.category,
    severity: value.severity,
    explanation: value.explanation
  };
}

function stripWorkingFeedbackItem(value: unknown): ContentFeedback<string> | unknown {
  if (!isRecord(value)) return value;
  const shared = {
    feedback_id: value.feedback_id,
    category: value.category,
    issue: value.issue,
    suggestion: value.suggestion,
    example: value.example
  };
  if (typeof value.original_sentence === "string") {
    return {
      ...shared,
      start: value.start,
      end: value.end,
      original_sentence: value.original_sentence,
      ...(typeof value.proposed_revision === "string"
        ? { proposed_revision: value.proposed_revision }
        : {})
    };
  }
  return shared;
}

function stripWorkingFeedbackItemV2(value: unknown) {
  if (!isRecord(value)) return value;
  return {
    feedback_id: value.feedback_id,
    category: value.category,
    original_sentence: value.original_sentence,
    issue: value.issue,
    suggestion: value.suggestion,
    example: value.example
  };
}

function stripWorkingFeedbackItemV21(value: unknown) {
  if (!isRecord(value)) return value;
  return {
    feedback_id: value.feedback_id,
    category: value.category,
    original_sentence: value.original_sentence,
    issue: value.issue,
    suggestion: value.suggestion,
    example: value.example,
    proposed_revision: value.proposed_revision
  };
}

function stripWorkingFeedbackItemV22(value: unknown) {
  if (!isRecord(value)) return value;
  return {
    feedback_id: value.feedback_id,
    category: value.category,
    original_sentence: value.original_sentence,
    issue: value.issue,
    suggestion: value.suggestion,
    proposed_revision: value.proposed_revision
  };
}

function stripTeacherScores(scores: CompatibleWorkingReviewScores) {
  return {
    official_score: {
      ai_score: scores.official_score.ai_score,
      rationale: scoreReferenceForValidation(scores.official_score.rationale)
    },
    dimension_scores: Object.fromEntries(
      Object.entries(scores.dimension_scores ?? {}).map(([key, dimension]) => [
        key,
        {
          ai_score: dimension.ai_score,
          ai_basis: scoreReferenceForValidation(dimension.ai_basis)
        }
      ])
    )
  };
}

function isLegacyV1Scores(value: unknown): value is {
  rubric_score: RubricScore;
  rationale: string;
} {
  return isRecord(value) && "rubric_score" in value;
}

function isNormalizedLegacyV1Scores(value: unknown) {
  return isRecord(value) && value.dimension_scores === null;
}

function normalizeLegacyCompatibleScores(value: unknown): CompatibleWorkingReviewScores {
  if (!isRecord(value) || !isRecord(value.official_score) || value.dimension_scores !== null) {
    throw invalid("legacy scores compatibility 格式无效。");
  }
  const official = value.official_score;
  assertExactKeys(official, ["ai_score", "teacher_score", "rationale"], "scores.official_score");
  assertScore(official.ai_score, "scores.official_score.ai_score");
  assertScore(official.teacher_score, "scores.official_score.teacher_score");
  if (typeof official.rationale !== "string") {
    throw invalid("scores.official_score.rationale 必须是字符串。");
  }
  return {
    official_score: {
      ai_score: official.ai_score as RubricScore,
      teacher_score: official.teacher_score as RubricScore,
      rationale: official.rationale
    },
    dimension_scores: null
  };
}

function scoreReferenceForValidation(value: string) {
  return value.trim().length > 0 ? value : EMPTY_SCORE_REFERENCE_VALIDATION_TEXT;
}

function overallFeedbackForValidation(value: string) {
  return value.trim().length > 0
    ? value
    : EMPTY_OVERALL_FEEDBACK_VALIDATION_TEXT;
}

export function workingReviewItemSource(value: { source?: unknown }) {
  return value.source === "teacher" ? "teacher" : "ai";
}

export function hasTeacherLanguageEditContent(value: {
  replacement_text?: unknown;
  explanation?: unknown;
}) {
  return hasAnyTrimmedText(value.replacement_text, value.explanation);
}

export function hasTeacherContentFeedbackContent(value: {
  issue?: unknown;
  suggestion?: unknown;
  proposed_revision?: unknown;
}) {
  return hasAnyTrimmedText(
    value.issue,
    value.suggestion,
    value.proposed_revision
  );
}

function readWorkingItemSource(value: unknown): WorkingReviewItemSource {
  if (!isRecord(value)) return "ai";
  if (value.source === undefined || value.source === "ai") return "ai";
  if (value.source === "teacher") return "teacher";
  throw invalid('working review item source 必须是 "ai" 或 "teacher"。');
}

function validateTeacherLanguageEdit(
  value: unknown,
  responseText: string,
  restored: boolean,
  index: number
): WorkingLanguageEdit {
  const path = `language_edits[${index}]`;
  if (!isRecord(value)) throw invalid(`${path} 格式无效。`);
  if (
    typeof value.edit_id !== "string" ||
    !value.edit_id ||
    !Number.isInteger(value.start) ||
    !Number.isInteger(value.end) ||
    typeof value.original_text !== "string" ||
    typeof value.replacement_text !== "string" ||
    !LANGUAGE_EDIT_CATEGORIES.includes(value.category as never) ||
    !LANGUAGE_EDIT_SEVERITIES.includes(value.severity as never) ||
    typeof value.explanation !== "string"
  ) {
    throw invalid(`${path} 教师语言修改格式无效。`);
  }
  if (!hasTeacherLanguageEditContent(value)) {
    throw invalid(TEACHER_REVIEW_CONTENT_REQUIRED_MESSAGE);
  }
  const start = value.start as number;
  const end = value.end as number;
  if (
    start < 0 ||
    end <= start ||
    end > responseText.length ||
    responseText.slice(start, end) !== value.original_text
  ) {
    throw invalid(`${path} offset 无效。`);
  }
  return {
    edit_id: value.edit_id,
    start,
    end,
    original_text: value.original_text,
    replacement_text: value.replacement_text,
    category: value.category as WorkingLanguageEdit["category"],
    severity: value.severity as WorkingLanguageEdit["severity"],
    explanation: value.explanation,
    restored,
    source: "teacher"
  };
}

function validateTeacherContentFeedback(
  value: unknown,
  taskType: WritingTaskType,
  responseText: string,
  included: boolean,
  index: number
): WorkingContentFeedbackItem {
  const path = `content_feedback.items[${index}]`;
  if (!isRecord(value)) throw invalid(`${path} 格式无效。`);
  const categories =
    taskType === "email"
      ? EMAIL_CONTENT_FEEDBACK_CATEGORIES_V2
      : ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES_V2;
  if (
    typeof value.feedback_id !== "string" ||
    !value.feedback_id ||
    !Number.isInteger(value.start) ||
    !Number.isInteger(value.end) ||
    typeof value.original_sentence !== "string" ||
    typeof value.issue !== "string" ||
    typeof value.suggestion !== "string" ||
    typeof value.proposed_revision !== "string" ||
    !categories.includes(value.category as never) &&
    value.category !== "social_conventions"
  ) {
    throw invalid(`${path} 教师内容反馈格式无效。`);
  }
  if (!hasTeacherContentFeedbackContent(value)) {
    throw invalid(TEACHER_REVIEW_CONTENT_REQUIRED_MESSAGE);
  }
  const start = value.start as number;
  const end = value.end as number;
  if (
    start < 0 ||
    end <= start ||
    end > responseText.length ||
    responseText.slice(start, end) !== value.original_sentence
  ) {
    throw invalid(`${path} offset 无效。`);
  }
  return {
    feedback_id: value.feedback_id,
    start,
    end,
    original_sentence: value.original_sentence,
    category: value.category as WorkingContentFeedbackItem["category"],
    issue: value.issue,
    suggestion: value.suggestion,
    proposed_revision: value.proposed_revision,
    included,
    source: "teacher"
  } as WorkingContentFeedbackItem;
}

function validateWorkingLanguageEditOverlap(edits: WorkingLanguageEdit[]) {
  const ordered = [...edits].sort(
    (left, right) => left.start - right.start || left.end - right.end
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].start < ordered[index - 1].end) {
      throw invalid("语言修改 offset 无效或发生重叠。");
    }
  }
}

function assertScore(value: unknown, path: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 5) {
    throw invalid(`${path} 必须是 0–5 的整数。`);
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalid(`${path} 字段结构无效。`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAnyTrimmedText(...values: unknown[]) {
  return values.some(
    (value) => typeof value === "string" && value.trim().length > 0
  );
}

function invalid(message: string, cause?: unknown) {
  return new WritingReviewWorkspaceValidationError(message, cause);
}
