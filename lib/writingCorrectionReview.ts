import type { WritingQuestion, WritingTaskType } from "./writing.ts";
import type { WritingCorrectionSourceSnapshot } from "./writing.ts";
import {
  CORRECTION_STATUSES,
  CORRECTION_SCORE_IMPACTS,
  CORRECTION_SEVERITIES,
  CORRECTION_NEW_ISSUE_TYPES,
  WRITING_CORRECTION_SCHEMA_VERSION,
  type CorrectionResolutionStatus,
  type WritingCorrectionReview
} from "./writingCorrectionReviewSchema.ts";
import { WRITING_CORRECTION_PROMPT_VERSION } from "./writingCorrectionReviewPrompt.ts";

/**
 * Phase 4 pure model. Everything here is deterministic and database-free so the
 * weighted completion rule and the AI/teacher/published separation can be unit
 * tested in isolation.
 */

export type CorrectionIssueType = "language_edit" | "content_feedback";

/** Confirmed weights: one content issue always equals three language edits. */
export const CORRECTION_ISSUE_WEIGHT: Record<CorrectionIssueType, number> = {
  language_edit: 1,
  content_feedback: 3
};

/** Confirmed completion factors. A missing judgement is treated as uncertain. */
export const CORRECTION_STATUS_FACTOR: Record<CorrectionResolutionStatus, number> = {
  resolved: 1,
  partially_resolved: 0.5,
  unresolved: 0,
  uncertain: 0
};

export type CorrectionSourceIssue = {
  issue_id: string;
  issue_type: CorrectionIssueType;
  category: string;
  severity: string | null;
  original_text: string | null;
  replacement_text: string | null;
  original_sentence: string | null;
  issue: string | null;
  suggestion: string | null;
  weight: number;
};

export type CorrectionNewIssueReview = {
  status: "accepted" | "dismissed";
  note: string;
};

export type CorrectionTeacherOverrides = {
  issue_statuses: Record<string, CorrectionResolutionStatus>;
  correction_score: number | null;
  score_rationale: string | null;
  new_issue_reviews: Record<string, CorrectionNewIssueReview>;
};

export type CorrectionIssueView = CorrectionSourceIssue & {
  ai_status: CorrectionResolutionStatus | null;
  ai_explanation: string;
  ai_evidence: string;
  ai_deletion_based: boolean;
  teacher_status: CorrectionResolutionStatus | null;
  effective_status: CorrectionResolutionStatus | null;
};

export type CorrectionNewIssueView = WritingCorrectionReview["new_issues"][number] & {
  index: number;
  review_status: "pending" | "accepted" | "dismissed";
  review_note: string;
};

export type CorrectionCompletion = {
  applicable: boolean;
  total_weight: number;
  completed_weight: number;
  rate: number | null;
  counts: Record<CorrectionResolutionStatus, number> & { undetermined: number };
};

export type CorrectionReviewState = {
  issues: CorrectionIssueView[];
  new_issues: CorrectionNewIssueView[];
  completion: CorrectionCompletion;
  original_score: number;
  ai_score: number | null;
  teacher_score: number | null;
  effective_score: number | null;
  score_delta: number | null;
  ai_rationale: string;
  teacher_rationale: string;
  effective_rationale: string;
  ai_score_change_explanation: string;
  ai_resolution_summary: string;
};

export const EMPTY_CORRECTION_TEACHER_OVERRIDES: CorrectionTeacherOverrides = {
  issue_statuses: {},
  correction_score: null,
  score_rationale: null,
  new_issue_reviews: {}
};

export class CorrectionReviewValidationError extends Error {
  code = "CORRECTION_REVIEW_INVALID" as const;
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "CorrectionReviewValidationError";
  }
}

/** Reads the frozen published LE/F as reviewable issues, in published order. */
export function correctionSourceIssues(
  snapshot: WritingCorrectionSourceSnapshot
): CorrectionSourceIssue[] {
  const review = snapshot.published_review;
  const issues: CorrectionSourceIssue[] = [];
  for (const raw of Array.isArray(review.language_edits) ? review.language_edits : []) {
    const edit = raw as Record<string, unknown>;
    if (typeof edit?.edit_id !== "string") continue;
    issues.push({
      issue_id: edit.edit_id,
      issue_type: "language_edit",
      category: typeof edit.category === "string" ? edit.category : "other",
      severity: typeof edit.severity === "string" ? edit.severity : null,
      original_text: typeof edit.original_text === "string" ? edit.original_text : null,
      replacement_text:
        typeof edit.replacement_text === "string" ? edit.replacement_text : null,
      original_sentence: null,
      issue: null,
      suggestion: null,
      weight: CORRECTION_ISSUE_WEIGHT.language_edit
    });
  }
  const feedback = review.content_feedback as { items?: unknown } | null;
  for (const raw of Array.isArray(feedback?.items) ? feedback!.items : []) {
    const item = raw as Record<string, unknown>;
    if (typeof item?.feedback_id !== "string") continue;
    issues.push({
      issue_id: item.feedback_id,
      issue_type: "content_feedback",
      category: typeof item.category === "string" ? item.category : "other",
      severity: null,
      original_text: null,
      replacement_text: null,
      original_sentence:
        typeof item.original_sentence === "string" ? item.original_sentence : null,
      issue: typeof item.issue === "string" ? item.issue : null,
      suggestion: typeof item.suggestion === "string" ? item.suggestion : null,
      weight: CORRECTION_ISSUE_WEIGHT.content_feedback
    });
  }
  return issues;
}

/** The published holistic score frozen with the source, never a fresh read. */
export function correctionOriginalScore(snapshot: WritingCorrectionSourceSnapshot): number {
  const scores = snapshot.published_review.scores as {
    official_score?: { teacher_score?: unknown; ai_score?: unknown };
  } | null;
  const teacher = scores?.official_score?.teacher_score;
  const ai = scores?.official_score?.ai_score;
  const value =
    typeof teacher === "number" && Number.isInteger(teacher) ? teacher :
    typeof ai === "number" && Number.isInteger(ai) ? ai : null;
  if (value === null || value < 0 || value > 5) {
    throw new CorrectionReviewValidationError("冻结快照中缺少有效的原始评分。");
  }
  return value;
}

/**
 * Weighted completion. AI never produces this value; it is always derived from
 * the per-issue statuses, with teacher overrides taking precedence.
 */
export function correctionCompletion(
  issues: Array<{ weight: number; status: CorrectionResolutionStatus | null }>
): CorrectionCompletion {
  const counts = {
    resolved: 0,
    partially_resolved: 0,
    unresolved: 0,
    uncertain: 0,
    undetermined: 0
  };
  let total = 0;
  let completed = 0;
  for (const issue of issues) {
    total += issue.weight;
    if (issue.status === null) {
      counts.undetermined += 1;
      continue;
    }
    counts[issue.status] += 1;
    completed += issue.weight * CORRECTION_STATUS_FACTOR[issue.status];
  }
  if (total === 0) {
    return { applicable: false, total_weight: 0, completed_weight: 0, rate: null, counts };
  }
  return {
    applicable: true,
    total_weight: total,
    completed_weight: completed,
    rate: completed / total,
    counts
  };
}

export function effectiveIssueStatus(
  aiStatus: CorrectionResolutionStatus | null,
  teacherStatus: CorrectionResolutionStatus | null
) {
  return teacherStatus ?? aiStatus ?? null;
}

/** Rejects anything the UI could not have produced and the DB must not store. */
export function parseCorrectionTeacherOverrides(
  value: unknown,
  issues: CorrectionSourceIssue[],
  newIssueCount: number
): CorrectionTeacherOverrides {
  if (value === undefined || value === null) return { ...EMPTY_CORRECTION_TEACHER_OVERRIDES };
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CorrectionReviewValidationError("教师审核数据格式无效。");
  }
  const record = value as Record<string, unknown>;
  const knownIds = new Set(issues.map((issue) => issue.issue_id));

  const statuses: Record<string, CorrectionResolutionStatus> = {};
  if (record.issue_statuses !== undefined) {
    if (typeof record.issue_statuses !== "object" || Array.isArray(record.issue_statuses)) {
      throw new CorrectionReviewValidationError("原始问题状态格式无效。");
    }
    for (const [issueId, status] of Object.entries(
      record.issue_statuses as Record<string, unknown>
    )) {
      if (!knownIds.has(issueId)) {
        throw new CorrectionReviewValidationError(`未知的原始问题 ID：${issueId}`);
      }
      if (
        typeof status !== "string" ||
        !(CORRECTION_STATUSES as readonly string[]).includes(status)
      ) {
        throw new CorrectionReviewValidationError(`原始问题状态无效：${issueId}`);
      }
      statuses[issueId] = status as CorrectionResolutionStatus;
    }
  }

  let correctionScore: number | null = null;
  if (record.correction_score !== undefined && record.correction_score !== null) {
    const score = record.correction_score;
    if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 5) {
      throw new CorrectionReviewValidationError("订正评分必须是 0–5 的整数。");
    }
    correctionScore = score;
  }

  let rationale: string | null = null;
  if (record.score_rationale !== undefined && record.score_rationale !== null) {
    if (typeof record.score_rationale !== "string" || record.score_rationale.length > 4000) {
      throw new CorrectionReviewValidationError("评分解释格式无效。");
    }
    const trimmed = record.score_rationale.trim();
    rationale = trimmed.length > 0 ? trimmed : null;
  }

  const newIssueReviews: Record<string, CorrectionNewIssueReview> = {};
  if (record.new_issue_reviews !== undefined) {
    if (
      typeof record.new_issue_reviews !== "object" ||
      Array.isArray(record.new_issue_reviews)
    ) {
      throw new CorrectionReviewValidationError("新问题审核格式无效。");
    }
    for (const [key, raw] of Object.entries(
      record.new_issue_reviews as Record<string, unknown>
    )) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= newIssueCount) {
        throw new CorrectionReviewValidationError(`未知的新问题序号：${key}`);
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new CorrectionReviewValidationError("新问题审核格式无效。");
      }
      const entry = raw as Record<string, unknown>;
      if (entry.status !== "accepted" && entry.status !== "dismissed") {
        throw new CorrectionReviewValidationError("新问题审核状态无效。");
      }
      const note = typeof entry.note === "string" ? entry.note.trim().slice(0, 1000) : "";
      newIssueReviews[String(index)] = { status: entry.status, note };
    }
  }

  return {
    issue_statuses: statuses,
    correction_score: correctionScore,
    score_rationale: rationale,
    new_issue_reviews: newIssueReviews
  };
}

export function correctionReviewState(input: {
  issues: CorrectionSourceIssue[];
  originalScore: number;
  ai: WritingCorrectionReview | null;
  teacher: CorrectionTeacherOverrides | null;
}): CorrectionReviewState {
  const teacher = input.teacher ?? EMPTY_CORRECTION_TEACHER_OVERRIDES;
  const byId = new Map(
    (input.ai?.issue_resolutions ?? []).map((item) => [item.issue_id, item])
  );
  const issues: CorrectionIssueView[] = input.issues.map((issue) => {
    const aiItem = byId.get(issue.issue_id) ?? null;
    const teacherStatus = teacher.issue_statuses[issue.issue_id] ?? null;
    return {
      ...issue,
      ai_status: aiItem?.status ?? null,
      ai_explanation: aiItem?.explanation ?? "",
      ai_evidence: aiItem?.evidence ?? "",
      ai_deletion_based: aiItem?.deletion_based ?? false,
      teacher_status: teacherStatus,
      effective_status: effectiveIssueStatus(aiItem?.status ?? null, teacherStatus)
    };
  });

  const newIssues: CorrectionNewIssueView[] = (input.ai?.new_issues ?? []).map(
    (item, index) => {
      const review = teacher.new_issue_reviews[String(index)] ?? null;
      return {
        ...item,
        index,
        review_status: review?.status ?? "pending",
        review_note: review?.note ?? ""
      };
    }
  );

  const completion = correctionCompletion(
    issues.map((issue) => ({ weight: issue.weight, status: issue.effective_status }))
  );

  const aiScore = input.ai?.correction_score ?? null;
  const teacherScore = teacher.correction_score;
  const effectiveScore = teacherScore ?? aiScore;
  return {
    issues,
    new_issues: newIssues,
    completion,
    original_score: input.originalScore,
    ai_score: aiScore,
    teacher_score: teacherScore,
    effective_score: effectiveScore,
    score_delta:
      effectiveScore === null ? null : effectiveScore - input.originalScore,
    ai_rationale: input.ai?.score_rationale ?? "",
    teacher_rationale: teacher.score_rationale ?? "",
    effective_rationale:
      teacher.score_rationale ?? input.ai?.score_rationale ?? "",
    ai_score_change_explanation: input.ai?.score_change_explanation ?? "",
    ai_resolution_summary: input.ai?.resolution_summary ?? ""
  };
}

export type CorrectionWorkspace = {
  attempt: {
    attempt_id: string;
    original_attempt_id: string;
    user_id: string;
    assignment_id: string | null;
    task_type: WritingTaskType;
    student_name: string;
    word_count: number | null;
    submitted_at: string | null;
  };
  question: WritingQuestion;
  question_source: "question_bank" | "custom";
  source: {
    original_response_text: string;
    original_score: number;
    published_at: string;
    review_id: string;
  };
  corrected_response_text: string;
  corrected_word_count: number;
  revision_state?: import("./writingRevisionState.ts").WritingRevisionState | null;
  review: {
    review_id: string | null;
    status: "reviewing" | "published";
    prompt_version: string;
    schema_version: string;
    ai_model: string | null;
    ai_generated_at: string | null;
    published_at: string | null;
    teacher: CorrectionTeacherOverrides;
    ai: WritingCorrectionReview | null;
    state: CorrectionReviewState;
    published: CorrectionPublishedSnapshot | null;
  };
};

/**
 * Re-applies teacher overrides to an existing state without re-reading the
 * source. Used by the workspace for instant feedback before saving, and by the
 * publish preview, so the displayed completion always matches the formula.
 */
export function recomputeCorrectionState(
  state: CorrectionReviewState,
  teacher: CorrectionTeacherOverrides
): CorrectionReviewState {
  const issues = state.issues.map((issue) => {
    const teacherStatus = teacher.issue_statuses[issue.issue_id] ?? null;
    return {
      ...issue,
      teacher_status: teacherStatus,
      effective_status: effectiveIssueStatus(issue.ai_status, teacherStatus)
    };
  });
  const newIssues = state.new_issues.map((issue) => {
    const review = teacher.new_issue_reviews[String(issue.index)] ?? null;
    return {
      ...issue,
      review_status: review?.status ?? ("pending" as const),
      review_note: review?.note ?? ""
    };
  });
  const completion = correctionCompletion(
    issues.map((issue) => ({ weight: issue.weight, status: issue.effective_status }))
  );
  const teacherScore = teacher.correction_score;
  const effectiveScore = teacherScore ?? state.ai_score;
  return {
    ...state,
    issues,
    new_issues: newIssues,
    completion,
    teacher_score: teacherScore,
    effective_score: effectiveScore,
    score_delta:
      effectiveScore === null ? null : effectiveScore - state.original_score,
    teacher_rationale: teacher.score_rationale ?? "",
    effective_rationale: teacher.score_rationale ?? state.ai_rationale
  };
}

export type CorrectionPublishedSnapshot = {
  schema_version: string;
  prompt_version: string;
  published_at: string;
  ai_model: string | null;
  ai_generated_at: string | null;
  original_score: number;
  correction_score: number;
  score_delta: number;
  score_rationale: string;
  score_change_explanation: string;
  resolution_summary: string;
  completion: CorrectionCompletion;
  issues: CorrectionIssueView[];
  new_issues: CorrectionNewIssueView[];
};

/**
 * Validates a stored published snapshot before it is used for display. A
 * published review must render exactly what was frozen, never a value
 * recomputed from mutable rows.
 */
export function assertPublishedSnapshot(value: unknown): CorrectionPublishedSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CorrectionReviewValidationError("已发布快照格式无效。");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.issues) || !Array.isArray(record.new_issues)) {
    throw new CorrectionReviewValidationError("已发布快照缺少问题列表。");
  }
  const completion = record.completion as Record<string, unknown> | null;
  if (
    !completion ||
    typeof completion !== "object" ||
    typeof completion.applicable !== "boolean" ||
    typeof completion.total_weight !== "number" ||
    typeof completion.completed_weight !== "number" ||
    !(completion.rate === null || typeof completion.rate === "number") ||
    !completion.counts ||
    typeof completion.counts !== "object"
  ) {
    throw new CorrectionReviewValidationError("已发布快照缺少完成度。");
  }
  for (const field of ["original_score", "correction_score"] as const) {
    const score = record[field];
    if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 5) {
      throw new CorrectionReviewValidationError("已发布快照的评分无效。");
    }
  }
  if (typeof record.score_delta !== "number") {
    throw new CorrectionReviewValidationError("已发布快照缺少分差。");
  }
  return value as CorrectionPublishedSnapshot;
}

/** Builds the read-only state from the frozen snapshot, not from live rows. */
export function correctionStateFromPublishedSnapshot(
  snapshot: CorrectionPublishedSnapshot,
  ai: WritingCorrectionReview | null
): CorrectionReviewState {
  const aiScore = ai?.correction_score ?? null;
  const teacherScore =
    aiScore === snapshot.correction_score ? null : snapshot.correction_score;
  return {
    issues: snapshot.issues,
    new_issues: snapshot.new_issues,
    completion: snapshot.completion,
    original_score: snapshot.original_score,
    ai_score: aiScore,
    teacher_score: teacherScore,
    effective_score: snapshot.correction_score,
    score_delta: snapshot.score_delta,
    ai_rationale: ai?.score_rationale ?? "",
    teacher_rationale: teacherScore === null ? "" : snapshot.score_rationale,
    effective_rationale: snapshot.score_rationale,
    ai_score_change_explanation: snapshot.score_change_explanation,
    ai_resolution_summary: snapshot.resolution_summary
  };
}

export function buildCorrectionPublishedSnapshot(input: {
  state: CorrectionReviewState;
  aiModel: string | null;
  aiGeneratedAt: string | null;
  publishedAt: string;
}): CorrectionPublishedSnapshot {
  const { state } = input;
  if (state.effective_score === null) {
    throw new CorrectionReviewValidationError("发布前必须先有订正评分。");
  }
  return {
    schema_version: WRITING_CORRECTION_SCHEMA_VERSION,
    prompt_version: WRITING_CORRECTION_PROMPT_VERSION,
    published_at: input.publishedAt,
    ai_model: input.aiModel,
    ai_generated_at: input.aiGeneratedAt,
    original_score: state.original_score,
    correction_score: state.effective_score,
    score_delta: state.effective_score - state.original_score,
    score_rationale: state.effective_rationale,
    score_change_explanation: state.ai_score_change_explanation,
    resolution_summary: state.ai_resolution_summary,
    completion: state.completion,
    issues: state.issues,
    new_issues: state.new_issues
  };
}

/** Extra contract checks that the JSON Schema alone cannot express. */
export function assertCorrectionReviewMatchesSource(
  review: WritingCorrectionReview,
  issues: CorrectionSourceIssue[],
  taskType: WritingTaskType
) {
  if (review.task_type !== taskType) {
    throw new CorrectionReviewValidationError("AI 返回的题型与作文不一致。");
  }
  const expected = new Set(issues.map((issue) => issue.issue_id));
  const seen = new Set<string>();
  for (const item of review.issue_resolutions) {
    if (!expected.has(item.issue_id)) {
      throw new CorrectionReviewValidationError(`AI 返回了未知的原始问题：${item.issue_id}`);
    }
    if (seen.has(item.issue_id)) {
      throw new CorrectionReviewValidationError(`AI 重复返回原始问题：${item.issue_id}`);
    }
    seen.add(item.issue_id);
    const source = issues.find((issue) => issue.issue_id === item.issue_id)!;
    if (source.issue_type !== item.issue_type) {
      throw new CorrectionReviewValidationError(`原始问题类型不匹配：${item.issue_id}`);
    }
  }
  const missing = issues
    .map((issue) => issue.issue_id)
    .filter((issueId) => !seen.has(issueId));
  if (missing.length > 0) {
    throw new CorrectionReviewValidationError(
      `AI 遗漏了原始问题：${missing.join(", ")}`
    );
  }
  for (const item of review.new_issues) {
    if (!(CORRECTION_NEW_ISSUE_TYPES as readonly string[]).includes(item.type)) {
      throw new CorrectionReviewValidationError("AI 返回了未知的新问题类型。");
    }
    if (!(CORRECTION_SEVERITIES as readonly string[]).includes(item.severity)) {
      throw new CorrectionReviewValidationError("AI 返回了未知的严重程度。");
    }
    if (!(CORRECTION_SCORE_IMPACTS as readonly string[]).includes(item.score_impact)) {
      throw new CorrectionReviewValidationError("AI 返回了未知的评分影响。");
    }
  }
}
