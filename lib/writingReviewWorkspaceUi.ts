import type { WritingTaskType } from "./writing.ts";
import {
  LANGUAGE_EDIT_CATEGORIES,
  type LanguageEditCategory
} from "./writingReviewSchema.ts";
import {
  ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES_V2,
  EMAIL_CONTENT_FEEDBACK_CATEGORIES_V2
} from "./writingReviewSchemaV2.ts";
import type {
  CompatibleWorkingReviewScores,
  WorkingContentFeedbackItem,
  WorkingLanguageEdit,
  WritingReviewWorkingDraft
} from "./writingReviewWorkspace.ts";
import { workingReviewItemSource } from "./writingReviewWorkspace.ts";
import type { RubricScore } from "./writingReviewSchemaV2.ts";
import { computeInlineRevisionDiff } from "./writingReviewInlineDiff.ts";
import { normalizeC3LanguageEditParts } from "./writingReviewV22Assembler.ts";
import type { InternalLanguageEditV2 } from "./writingReviewSchemaV2.ts";

export type LanguageEditFilter = "all" | "major" | "moderate" | "minor";

export type WorkspaceAnnotationSegment = {
  start: number;
  end: number;
  originalText: string;
  displayText: string;
  edit: WorkingLanguageEdit | null;
  feedbackIds: string[];
  feedbackStarts: string[];
};

export type DimensionDefinition = {
  key: string;
  zh: string;
  en: string;
};

export type FeedbackCategoryDefinition = {
  key: string;
  label: string;
};

export type SourceTextSelection = {
  start: number;
  end: number;
  originalText: string;
};

export type LanguageEditDisplayRange = {
  localStart: number;
  localEnd: number;
  sourceStart: number;
  sourceEnd: number;
  prefix: string;
  changedOriginal: string;
  suffix: string;
  insertion: boolean;
};

export const CONTENT_FEEDBACK_MARKER_CLASS =
  "mx-0.5 inline-flex translate-y-[-1px] items-center rounded bg-violet-100 px-1 py-0.5 text-[9px] font-bold leading-none text-student-primary hover:bg-violet-200";

export function languageEditSeverityMarkerClass(
  severity: string,
  selected = false
) {
  const background = severity === "major"
    ? selected ? "bg-red-100" : "bg-red-50"
    : severity === "moderate"
      ? selected ? "bg-amber-100" : "bg-amber-50"
      : selected ? "bg-emerald-100" : "bg-emerald-50";
  return `rounded-sm px-0.5 font-medium transition-colors ${background}`;
}

export function languageEditSeverityLabel(severity: string) {
  return severity === "major" ? "严重" : severity === "moderate" ? "一般" : "轻微";
}

export type ViewportAnchorRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
};

export const LANGUAGE_EDIT_OVERLAP_MESSAGE =
  "所选内容与现有语言修改重叠，请点击现有标记直接编辑，或先取消/处理该修改。";

const CATEGORY_LABELS: Record<string, string> = {
  grammar: "语法",
  spelling: "拼写",
  capitalization: "大小写",
  punctuation: "标点",
  word_choice: "用词",
  word_form: "词形",
  syntax: "句法",
  usage: "用法",
  social_convention: "社交规范",
  communicative_purpose: "交际目的",
  elaboration: "展开",
  social_conventions: "社交规范",
  organization: "组织",
  language_improvement: "语言提升",
  relevance: "相关性",
  discussion_contribution: "讨论贡献",
  logic: "逻辑",
  other: "其他"
};

export const TEACHER_LANGUAGE_EDIT_CATEGORIES = LANGUAGE_EDIT_CATEGORIES.filter(
  (category) => category !== "social_convention"
);

const EMAIL_DIMENSIONS: DimensionDefinition[] = [
  {
    key: "communicative_purpose_and_elaboration",
    zh: "交际目的与展开",
    en: "Communicative Purpose & Elaboration"
  },
  {
    key: "syntactic_range_and_word_choice",
    zh: "句法范围与词语选择",
    en: "Syntactic Range & Word Choice"
  },
  { key: "social_conventions", zh: "社交规范", en: "Social Conventions" },
  {
    key: "lexical_and_grammatical_control",
    zh: "词汇与语法控制",
    en: "Lexical & Grammatical Control"
  }
];

const DISCUSSION_DIMENSIONS: DimensionDefinition[] = [
  { key: "relevance", zh: "相关性", en: "Relevance" },
  { key: "elaboration", zh: "展开", en: "Elaboration" },
  {
    key: "syntactic_range_and_word_choice",
    zh: "句法范围与词语选择",
    en: "Syntactic Range & Word Choice"
  },
  {
    key: "lexical_and_grammatical_control",
    zh: "词汇与语法控制",
    en: "Lexical & Grammatical Control"
  }
];

const EMAIL_FEEDBACK_CATEGORIES: FeedbackCategoryDefinition[] =
  EMAIL_CONTENT_FEEDBACK_CATEGORIES_V2.map((key) => ({
    key,
    label: writingReviewCategoryLabel(key)
  }));

const DISCUSSION_FEEDBACK_CATEGORIES: FeedbackCategoryDefinition[] =
  ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES_V2.map((key) => ({
    key,
    label: writingReviewCategoryLabel(key)
  }));

export function writingDimensionDefinitions(taskType: WritingTaskType) {
  return taskType === "email" ? EMAIL_DIMENSIONS : DISCUSSION_DIMENSIONS;
}

export function writingFeedbackCategoryDefinitions(taskType: WritingTaskType) {
  return taskType === "email"
    ? EMAIL_FEEDBACK_CATEGORIES
    : DISCUSSION_FEEDBACK_CATEGORIES;
}

export function writingLanguageEditCategoryDefinitions() {
  return TEACHER_LANGUAGE_EDIT_CATEGORIES.map((key) => ({
    key,
    label: writingReviewCategoryLabel(key)
  }));
}

export function languageEditDisplayRange(
  edit: Pick<WorkingLanguageEdit, "start" | "original_text" | "replacement_text">
): LanguageEditDisplayRange {
  const diff = computeInlineRevisionDiff(
    edit.original_text,
    edit.replacement_text
  );
  const localStart = diff.prefix.length;
  const localEnd = edit.original_text.length - diff.suffix.length;
  return {
    localStart,
    localEnd,
    sourceStart: edit.start + localStart,
    sourceEnd: edit.start + localEnd,
    prefix: diff.prefix,
    changedOriginal: diff.originalChanged,
    suffix: diff.suffix,
    insertion: localStart === localEnd && diff.replacementChanged.length > 0
  };
}

export function selectionActionPosition(
  anchor: ViewportAnchorRect,
  viewportWidth: number,
  viewportHeight: number,
  options: { width?: number; height?: number; gap?: number; margin?: number } = {}
) {
  const width = options.width ?? 128;
  const height = options.height ?? 34;
  const gap = options.gap ?? 8;
  const margin = options.margin ?? 12;
  const centeredLeft = anchor.left + anchor.width / 2 - width / 2;
  const left = Math.max(
    margin,
    Math.min(centeredLeft, viewportWidth - width - margin)
  );
  const above = anchor.top - height - gap;
  const below = anchor.bottom + gap;
  const top = above >= margin
    ? above
    : Math.min(below, viewportHeight - height - margin);
  return { left, top: Math.max(margin, top) };
}

export function writingReviewCategoryLabel(value: string) {
  return CATEGORY_LABELS[value] ?? value.replaceAll("_", " ");
}

export function sourceTextSelection(
  responseText: string,
  firstOffset: number,
  secondOffset: number
): SourceTextSelection | null {
  const start = Math.min(firstOffset, secondOffset);
  const end = Math.max(firstOffset, secondOffset);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > responseText.length
  ) {
    return null;
  }
  return { start, end, originalText: responseText.slice(start, end) };
}

export function overlapsLanguageEdit(
  selection: Pick<SourceTextSelection, "start" | "end">,
  edits: WorkingLanguageEdit[]
) {
  return edits.some(
    (edit) => selection.start < edit.end && selection.end > edit.start
  );
}

export function createTeacherLanguageEdit(
  input: SourceTextSelection & {
    category: LanguageEditCategory;
    replacementText: string;
    explanation?: string;
  },
  idFactory: () => string = () => createWorkingItemId("teacher-edit")
): WorkingLanguageEdit {
  return {
    edit_id: idFactory(),
    source: "teacher",
    start: input.start,
    end: input.end,
    original_text: input.originalText,
    replacement_text: input.replacementText,
    category: input.category,
    severity: "moderate",
    explanation: input.explanation ?? "",
    restored: false
  };
}

export function createTeacherContentFeedback(
  input: SourceTextSelection & {
    category: string;
    issue: string;
    suggestion?: string;
    proposedRevision?: string;
  },
  idFactory: () => string = () => createWorkingItemId("teacher-feedback")
): WorkingContentFeedbackItem {
  return {
    feedback_id: idFactory(),
    source: "teacher",
    start: input.start,
    end: input.end,
    original_sentence: input.originalText,
    category: input.category,
    issue: input.issue,
    suggestion: input.suggestion ?? "",
    proposed_revision: input.proposedRevision ?? "",
    included: true
  } as WorkingContentFeedbackItem;
}

export function isLocatedContentFeedback(
  item: WorkingContentFeedbackItem
): item is WorkingContentFeedbackItem & {
  start: number;
  end: number;
  original_sentence: string;
} {
  return (
    typeof (item as { start?: unknown }).start === "number" &&
    typeof (item as { end?: unknown }).end === "number" &&
    typeof (item as { original_sentence?: unknown }).original_sentence === "string"
  );
}

/**
 * Builds display segments from response_text's original coordinate system.
 * Replacements never become a coordinate source, so sentence feedback remains
 * correctly attached even when a nested language edit changes text length.
 */
export function buildWorkspaceAnnotationSegments(
  responseText: string,
  languageEdits: WorkingLanguageEdit[],
  feedbackItems: WorkingContentFeedbackItem[]
): WorkspaceAnnotationSegment[] {
  const edits = [...languageEdits].sort(
    (left, right) => left.start - right.start || left.end - right.end
  );
  let previousEnd = 0;
  for (const edit of edits) {
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < previousEnd ||
      edit.end <= edit.start ||
      edit.end > responseText.length ||
      responseText.slice(edit.start, edit.end) !== edit.original_text
    ) {
      throw new Error("语言修改 offset 无效或发生重叠。");
    }
    previousEnd = edit.end;
  }

  const locatedFeedback = feedbackItems
    .filter(isLocatedContentFeedback)
    .sort(
      (left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        left.feedback_id.localeCompare(right.feedback_id)
    );
  for (const item of locatedFeedback) {
    if (
      !Number.isInteger(item.start) ||
      !Number.isInteger(item.end) ||
      item.start < 0 ||
      item.end <= item.start ||
      item.end > responseText.length ||
      responseText.slice(item.start, item.end) !== item.original_sentence
    ) {
      throw new Error("内容反馈 offset 无效。");
    }
  }

  const segments: WorkspaceAnnotationSegment[] = [];
  let cursor = 0;
  for (const edit of edits) {
    appendPlainSegments(segments, responseText, cursor, edit.start, locatedFeedback);
    segments.push(createSegment(responseText, edit.start, edit.end, edit, locatedFeedback));
    cursor = edit.end;
  }
  appendPlainSegments(segments, responseText, cursor, responseText.length, locatedFeedback);
  return segments;
}

export function filterLanguageEdits(
  edits: WorkingLanguageEdit[],
  filter: LanguageEditFilter
) {
  return filter === "all" ? edits : edits.filter((edit) => edit.severity === filter);
}

export function adjacentLanguageEditId(
  edits: WorkingLanguageEdit[],
  selectedEditId: string | null,
  direction: -1 | 1
) {
  if (edits.length === 0) return null;
  const currentIndex = edits.findIndex((edit) => edit.edit_id === selectedEditId);
  if (currentIndex < 0) return edits[direction > 0 ? 0 : edits.length - 1].edit_id;
  return edits[(currentIndex + direction + edits.length) % edits.length].edit_id;
}

export function countTeacherEditedLanguageEdits(
  aiReviewRaw: unknown,
  edits: WorkingLanguageEdit[]
) {
  if (
    !isRecord(aiReviewRaw) ||
    (aiReviewRaw.schema_version !== "2.0" &&
      aiReviewRaw.schema_version !== "2.1" &&
      aiReviewRaw.schema_version !== "2.2")
  ) return null;
  if (!Array.isArray(aiReviewRaw.language_edits)) return null;
  const rawById = new Map<string, string>();
  for (const value of aiReviewRaw.language_edits) {
    if (
      !isRecord(value) ||
      typeof value.edit_id !== "string" ||
      typeof value.replacement_text !== "string"
    ) {
      return null;
    }
    rawById.set(value.edit_id, value.replacement_text);
    if (
      /^c3-edit-\d+$/.test(value.edit_id) &&
      typeof value.original_text === "string" &&
      typeof value.category === "string" &&
      typeof value.severity === "string" &&
      typeof value.explanation === "string"
    ) {
      const parts = normalizeC3LanguageEditParts({
        ...value,
        start: 0,
        end: value.original_text.length,
        restored: false
      } as InternalLanguageEditV2);
      parts.forEach((part) => rawById.set(part.edit_id, part.replacement_text));
    }
  }
  const aiEdits = edits.filter((edit) => workingReviewItemSource(edit) === "ai");
  if (aiEdits.some((edit) => !rawById.has(edit.edit_id))) return null;
  return aiEdits.filter(
    (edit) => rawById.get(edit.edit_id) !== edit.replacement_text
  ).length;
}

export function hasWritingReviewTeacherContent(
  draft: WritingReviewWorkingDraft,
  aiReviewRaw: unknown,
  hasAiReview: boolean
) {
  if (
    draft.language_edits.some(
      (edit) => workingReviewItemSource(edit) === "teacher" || edit.restored
    ) ||
    draft.content_feedback.items.some(
      (item) =>
        workingReviewItemSource(item) === "teacher" || item.included === false
    )
  ) {
    return true;
  }

  const editedAiLanguageCount = countTeacherEditedLanguageEdits(
    aiReviewRaw,
    draft.language_edits
  );
  if (editedAiLanguageCount !== null && editedAiLanguageCount > 0) return true;

  const official = draft.scores.official_score;
  if (official.teacher_score !== official.ai_score) return true;
  if (
    draft.scores.dimension_scores &&
    Object.values(draft.scores.dimension_scores).some(
      (dimension) => dimension.teacher_score !== dimension.ai_score
    )
  ) {
    return true;
  }

  const rawFinalFields = readAiFinalFields(aiReviewRaw);
  if (!hasAiReview) {
    return (
      official.rationale.length > 0 ||
      (draft.scores.dimension_scores !== null &&
        Object.values(draft.scores.dimension_scores).some(
          (dimension) => dimension.ai_basis.length > 0
        )) ||
      draft.content_feedback.overall_feedback.length > 0 ||
      draft.teacher_comment.length > 0
    );
  }

  if (
    rawFinalFields.officialReference === null ||
    official.rationale !== rawFinalFields.officialReference
  ) {
    return true;
  }
  if (
    draft.scores.dimension_scores &&
    Object.entries(draft.scores.dimension_scores).some(
      ([key, dimension]) =>
        rawFinalFields.dimensionReferences[key] === undefined ||
        dimension.ai_basis !== rawFinalFields.dimensionReferences[key]
    )
  ) {
    return true;
  }
  return (
    rawFinalFields.overallFeedback === null ||
    draft.content_feedback.overall_feedback !== rawFinalFields.overallFeedback ||
    draft.teacher_comment.length > 0
  );
}

function readAiFinalFields(value: unknown) {
  if (!isRecord(value)) {
    return {
      officialReference: null,
      dimensionReferences: {} as Record<string, string>,
      overallFeedback: null
    };
  }
  const scores = isRecord(value.scores) ? value.scores : null;
  const official = isRecord(scores?.official_score)
    ? scores.official_score
    : isRecord(value.score)
      ? value.score
      : null;
  const dimensions = isRecord(scores?.dimension_scores)
    ? Object.fromEntries(
        Object.entries(scores.dimension_scores).flatMap(([key, dimension]) =>
          isRecord(dimension) && typeof dimension.ai_basis === "string"
            ? [[key, dimension.ai_basis]]
            : []
        )
      )
    : {};
  return {
    officialReference:
      typeof official?.rationale === "string" ? official.rationale : null,
    dimensionReferences: dimensions as Record<string, string>,
    overallFeedback:
      typeof value.overall_feedback === "string" ? value.overall_feedback : null
  };
}

export function updateDimensionTeacherScore(
  scores: CompatibleWorkingReviewScores,
  key: string,
  teacherScore: RubricScore
) {
  if (!scores.dimension_scores || !scores.dimension_scores[key as keyof typeof scores.dimension_scores]) {
    return scores;
  }
  return {
    ...scores,
    dimension_scores: {
      ...scores.dimension_scores,
      [key]: {
        ...scores.dimension_scores[key as keyof typeof scores.dimension_scores],
        teacher_score: teacherScore
      }
    }
  };
}

export function updateOfficialTeacherScore(
  scores: CompatibleWorkingReviewScores,
  teacherScore: RubricScore
) {
  return {
    ...scores,
    official_score: { ...scores.official_score, teacher_score: teacherScore }
  };
}

export function updateDimensionScoreBasis(
  scores: CompatibleWorkingReviewScores,
  key: string,
  basis: string
) {
  if (!scores.dimension_scores || !scores.dimension_scores[key as keyof typeof scores.dimension_scores]) {
    return scores;
  }
  return {
    ...scores,
    dimension_scores: {
      ...scores.dimension_scores,
      [key]: {
        ...scores.dimension_scores[key as keyof typeof scores.dimension_scores],
        ai_basis: basis
      }
    }
  };
}

export function updateOfficialScoreRationale(
  scores: CompatibleWorkingReviewScores,
  rationale: string
) {
  return {
    ...scores,
    official_score: { ...scores.official_score, rationale }
  };
}

export function mergeRegeneratedFeedback(
  draft: WritingReviewWorkingDraft,
  result: {
    feedback_id: string;
    suggestion: string;
    proposed_revision: string;
  }
) {
  return {
    ...draft,
    content_feedback: {
      ...draft.content_feedback,
      items: draft.content_feedback.items.map((item) =>
        item.feedback_id === result.feedback_id
          ? {
              ...item,
              suggestion: result.suggestion,
              proposed_revision: result.proposed_revision
            }
          : item
      )
    }
  };
}

export function mergeRegeneratedDraftPreservingTeacherItems(
  responseText: string,
  regenerated: WritingReviewWorkingDraft,
  current: WritingReviewWorkingDraft
) {
  const teacherEdits = mergeTeacherItemsById(
    regenerated.language_edits,
    current.language_edits,
    (item) => item.edit_id
  );
  teacherEdits.forEach((edit) => {
    if (responseText.slice(edit.start, edit.end) !== edit.original_text) {
      throw new Error("教师语言修改定位已经失效。");
    }
  });
  const aiEdits = regenerated.language_edits.filter(
    (edit) =>
      workingReviewItemSource(edit) === "ai" &&
      !overlapsLanguageEdit(edit, teacherEdits)
  );
  const teacherFeedback = mergeTeacherItemsById(
    regenerated.content_feedback.items,
    current.content_feedback.items,
    (item) => item.feedback_id
  );
  return {
    ...regenerated,
    scores: {
      ...regenerated.scores,
      official_score: {
        ...regenerated.scores.official_score,
        teacher_score: current.scores.official_score.teacher_score
      },
      dimension_scores:
        regenerated.scores.dimension_scores && current.scores.dimension_scores
          ? Object.fromEntries(
              Object.entries(regenerated.scores.dimension_scores).map(
                ([key, dimension]) => [
                  key,
                  {
                    ...dimension,
                    teacher_score:
                      current.scores.dimension_scores?.[
                        key as keyof typeof current.scores.dimension_scores
                      ]?.teacher_score ?? dimension.teacher_score
                  }
                ]
              )
            ) as typeof regenerated.scores.dimension_scores
          : regenerated.scores.dimension_scores
    },
    language_edits: [...teacherEdits, ...aiEdits].sort(
      (left, right) => left.start - right.start || left.end - right.end
    ),
    content_feedback: {
      ...regenerated.content_feedback,
      items: [
        ...regenerated.content_feedback.items.filter(
          (item) => workingReviewItemSource(item) === "ai"
        ),
        ...teacherFeedback
      ]
    },
    teacher_comment: current.teacher_comment
  };
}

export function calculateContainedScrollTop(input: {
  containerScrollTop: number;
  containerTop: number;
  targetTop: number;
  offset?: number;
}) {
  return Math.max(
    0,
    input.containerScrollTop +
      input.targetTop -
      input.containerTop -
      (input.offset ?? 18)
  );
}

function appendPlainSegments(
  segments: WorkspaceAnnotationSegment[],
  responseText: string,
  start: number,
  end: number,
  feedbackItems: Array<WorkingContentFeedbackItem & {
    start: number;
    end: number;
    original_sentence: string;
  }>
) {
  if (end <= start) return;
  const boundaries = new Set([start, end]);
  for (const item of feedbackItems) {
    if (item.start > start && item.start < end) boundaries.add(item.start);
    if (item.end > start && item.end < end) boundaries.add(item.end);
  }
  const positions = Array.from(boundaries).sort((left, right) => left - right);
  for (let index = 0; index < positions.length - 1; index += 1) {
    segments.push(
      createSegment(
        responseText,
        positions[index],
        positions[index + 1],
        null,
        feedbackItems
      )
    );
  }
}

function createSegment(
  responseText: string,
  start: number,
  end: number,
  edit: WorkingLanguageEdit | null,
  feedbackItems: Array<WorkingContentFeedbackItem & {
    start: number;
    end: number;
    original_sentence: string;
  }>
): WorkspaceAnnotationSegment {
  const feedbackIds = feedbackItems
    .filter((item) => item.start < end && item.end > start)
    .map((item) => item.feedback_id);
  const feedbackStarts = feedbackItems
    .filter((item) => item.start >= start && item.start < end)
    .map((item) => item.feedback_id);
  const originalText = responseText.slice(start, end);
  return {
    start,
    end,
    originalText,
    displayText: originalText,
    edit,
    feedbackIds,
    feedbackStarts
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createWorkingItemId(prefix: string) {
  const suffix = globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function mergeTeacherItemsById<T extends { source?: unknown }>(
  regenerated: T[],
  current: T[],
  id: (item: T) => string
) {
  const merged = new Map<string, T>();
  regenerated
    .filter((item) => workingReviewItemSource(item) === "teacher")
    .forEach((item) => merged.set(id(item), item));
  current
    .filter((item) => workingReviewItemSource(item) === "teacher")
    .forEach((item) => merged.set(id(item), item));
  return Array.from(merged.values());
}
