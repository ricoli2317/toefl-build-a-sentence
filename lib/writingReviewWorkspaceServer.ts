import type { SupabaseClient } from "@supabase/supabase-js";
import { getPreferredUserDisplayName } from "./userDisplayName.ts";
import {
  readWritingAttemptForReview,
  readWritingQuestionForReview
} from "./writingReviewSource.ts";
import {
  buildManualWritingReviewDraft,
  buildWritingReviewPublishUpdate,
  buildWritingReviewSaveUpdate,
  normalizeWritingReviewWorkingDraft,
  WritingReviewWorkspaceValidationError,
  type WritingReviewWorkingDraft
} from "./writingReviewWorkspace.ts";

const REVIEW_FIELDS =
  "review_id,attempt_id,status,ai_model,ai_generated_at,ai_review_raw,language_edits,scores,content_feedback,teacher_comment,published_language_edits,published_scores,published_content_feedback,published_teacher_comment,published_at,updated_at";

export type WritingReviewWorkspaceErrorCode =
  | "UNAUTHORIZED"
  | "ATTEMPT_NOT_FOUND"
  | "ATTEMPT_NOT_SUBMITTED"
  | "QUESTION_NOT_FOUND"
  | "WORKSPACE_INVALID"
  | "DATABASE_READ_FAILED"
  | "REVIEW_SAVE_FAILED"
  | "REVIEW_PUBLISH_FAILED";

export class WritingReviewWorkspaceServerError extends Error {
  code: WritingReviewWorkspaceErrorCode;
  status: number;

  constructor(code: WritingReviewWorkspaceErrorCode, message: string, status: number) {
    super(message);
    this.name = "WritingReviewWorkspaceServerError";
    this.code = code;
    this.status = status;
  }
}

export function assertWritingReviewTeacher(auth: {
  error: string | null;
  userId: string | null;
}) {
  if (!auth.error && auth.userId) return;
  throw new WritingReviewWorkspaceServerError(
    "UNAUTHORIZED",
    "无权访问教师端批改数据。",
    auth.error === "Unauthorized" ? 403 : 401
  );
}

export async function loadWritingReviewWorkspace(
  supabase: SupabaseClient,
  attemptId: string
) {
  const attemptResult = await readWritingAttemptForReview(supabase, attemptId);
  if (attemptResult.error) throw databaseReadError();
  const attempt = attemptResult.data;
  if (!attempt) {
    throw new WritingReviewWorkspaceServerError(
      "ATTEMPT_NOT_FOUND",
      "未找到这条写作提交。",
      404
    );
  }
  if (attempt.status !== "submitted") {
    throw new WritingReviewWorkspaceServerError(
      "ATTEMPT_NOT_SUBMITTED",
      "只有已提交的写作才能进入批改工作台。",
      409
    );
  }

  const [questionResult, profileResult, reviewResult] = await Promise.all([
    readWritingQuestionForReview(
      supabase,
      attempt.task_type,
      attempt.question_id,
      attempt.assignment_id
    ),
    supabase
      .from("profiles")
      .select("id,email,full_name")
      .eq("id", attempt.user_id)
      .maybeSingle(),
    supabase
      .from("writing_reviews")
      .select(REVIEW_FIELDS)
      .eq("attempt_id", attempt.attempt_id)
      .maybeSingle()
  ]);

  if (questionResult.error || profileResult.error || reviewResult.error) {
    throw databaseReadError();
  }
  if (!questionResult.data) {
    throw new WritingReviewWorkspaceServerError(
      "QUESTION_NOT_FOUND",
      "未找到对应的写作原题。",
      404
    );
  }
  const review = reviewResult.data
    ? normalizeReviewRow(
        reviewResult.data as Record<string, unknown>,
        attempt.task_type,
        attempt.response_text
      )
    : buildUnsavedManualReview(attempt.task_type);
  const profile = profileResult.data as {
    email?: string | null;
    full_name?: string | null;
  } | null;

  return {
    attempt: {
      attempt_id: attempt.attempt_id,
      assignment_id: attempt.assignment_id ?? null,
      user_id: attempt.user_id,
      student_name: getPreferredUserDisplayName({
        email: profile?.email,
        profileFullName: profile?.full_name
      }),
      task_type: attempt.task_type,
      question_id: attempt.question_id,
      set_id: attempt.set_id,
      response_text: attempt.response_text,
      word_count: attempt.word_count,
      writing_mode: attempt.writing_mode,
      elapsed_seconds: attempt.elapsed_seconds,
      overtime_ranges: attempt.overtime_ranges,
      submitted_at: attempt.submitted_at
    },
    question: questionResult.data,
    question_source: questionResult.questionSource,
    review
  };
}

export async function saveWritingReviewWorkspace(
  supabase: SupabaseClient,
  attemptId: string,
  body: unknown,
  options?: { publish?: boolean; now?: () => Date }
) {
  const loaded = await loadWritingReviewWorkspace(supabase, attemptId);
  const draft = normalizeRequestDraft(
    body,
    loaded.attempt.task_type,
    loaded.attempt.response_text
  );
  const publish = options?.publish === true;
  const publishedAt = (options?.now ?? (() => new Date()))().toISOString();
  if (
    publish &&
    loaded.review.status === "published" &&
    publishedSnapshotMatchesDraft(loaded.review, draft)
  ) {
    return loaded.review;
  }
  const mutation = publish
    ? buildWritingReviewPublishUpdate(draft, publishedAt)
    : buildWritingReviewSaveUpdate(draft);
  const inserting = !loaded.review.review_id;
  let reviewQuery;
  if (loaded.review.review_id) {
    reviewQuery = supabase
      .from("writing_reviews")
      .update(mutation)
      .eq("attempt_id", attemptId);
    if (publish) {
      reviewQuery = reviewQuery.eq("status", loaded.review.status);
      if (loaded.review.updated_at) {
        reviewQuery = reviewQuery.eq("updated_at", loaded.review.updated_at);
      }
    }
  } else {
    reviewQuery = supabase.from("writing_reviews").insert({
      attempt_id: attemptId,
      task_type: loaded.attempt.task_type,
      status: publish ? "published" : "reviewing",
      ai_model: null,
      ai_generated_at: null,
      ai_review_raw: null,
      ...mutation
    });
  }
  const { data, error } = await reviewQuery.select(REVIEW_FIELDS).maybeSingle();

  if (error || !data) {
    const canConfirmConcurrentResult =
      (!error && !data) || (inserting && error?.code === "23505");
    if (canConfirmConcurrentResult) {
      const current = await loadWritingReviewWorkspace(supabase, attemptId);
      const mutationReachedServer = publish
        ? current.review.status === "published" &&
          publishedSnapshotMatchesDraft(current.review, draft)
        : workingDraftMatchesReview(current.review, draft);
      if (mutationReachedServer) return current.review;
    }
    throw new WritingReviewWorkspaceServerError(
      publish ? "REVIEW_PUBLISH_FAILED" : "REVIEW_SAVE_FAILED",
      publish ? "发布失败，请稍后重试。" : "保存失败，请稍后重试。",
      500
    );
  }

  return normalizeReviewRow(
    data as Record<string, unknown>,
    loaded.attempt.task_type,
    loaded.attempt.response_text
  );
}

export function workingDraftMatchesReview(
  review: WritingReviewWorkingDraft,
  draft: WritingReviewWorkingDraft
) {
  const expected = buildWritingReviewSaveUpdate(draft);
  return (
    jsonValuesEqual(review.language_edits, expected.language_edits) &&
    jsonValuesEqual(review.scores, expected.scores) &&
    jsonValuesEqual(
      review.scores.dimension_scores === null
        ? review.content_feedback
        : {
            items: review.content_feedback.items,
            overall_feedback: review.content_feedback.overall_feedback
          },
      expected.content_feedback
    ) &&
    review.teacher_comment === expected.teacher_comment
  );
}

export function publishedSnapshotMatchesDraft(
  review: {
    published_language_edits?: unknown;
    published_scores?: unknown;
    published_content_feedback?: unknown;
    published_teacher_comment?: string | null;
  },
  draft: WritingReviewWorkingDraft
) {
  const expected = buildWritingReviewPublishUpdate(
    draft,
    "1970-01-01T00:00:00.000Z"
  );
  return (
    jsonValuesEqual(
      review.published_language_edits,
      expected.published_language_edits
    ) &&
    jsonValuesEqual(review.published_scores, expected.published_scores) &&
    jsonValuesEqual(
      review.published_content_feedback,
      expected.published_content_feedback
    ) &&
    review.published_teacher_comment === expected.published_teacher_comment
  );
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && jsonValuesEqual(left[key], right[key])
    )
  );
}

function normalizeRequestDraft(
  body: unknown,
  taskType: "email" | "academic_discussion",
  responseText: string
) {
  if (!isRecord(body)) {
    throw new WritingReviewWorkspaceServerError(
      "WORKSPACE_INVALID",
      "批改工作稿格式无效。",
      400
    );
  }
  try {
    return normalizeWritingReviewWorkingDraft({
      taskType,
      responseText,
      languageEdits: body.language_edits,
      scores: body.scores,
      contentFeedback: body.content_feedback,
      teacherComment: body.teacher_comment
    });
  } catch (error) {
    if (error instanceof WritingReviewWorkspaceValidationError) {
      throw new WritingReviewWorkspaceServerError(
        "WORKSPACE_INVALID",
        error.message,
        400
      );
    }
    throw error;
  }
}

function normalizeReviewRow(
  row: Record<string, unknown>,
  taskType: "email" | "academic_discussion",
  responseText: string
) {
  let draft: WritingReviewWorkingDraft;
  try {
    draft = normalizeWritingReviewWorkingDraft({
      taskType,
      responseText,
      languageEdits: row.language_edits,
      scores: row.scores,
      contentFeedback: row.content_feedback,
      teacherComment: row.teacher_comment
    });
  } catch (error) {
    throw new WritingReviewWorkspaceServerError(
      "WORKSPACE_INVALID",
      "数据库中的批改工作稿格式无效。",
      500
    );
  }

  const legacyTeacherOverall =
    typeof row.teacher_comment === "string" && row.teacher_comment.length > 0
      ? row.teacher_comment
      : null;
  const finalDraft: WritingReviewWorkingDraft = {
    ...draft,
    content_feedback: legacyTeacherOverall === null
      ? draft.content_feedback
      : {
          ...draft.content_feedback,
          overall_feedback: legacyTeacherOverall
        },
    teacher_comment: ""
  };

  return {
    review_id: String(row.review_id),
    status: row.status === "published" ? "published" : "reviewing",
    has_ai_review:
      typeof row.ai_generated_at === "string" && row.ai_generated_at.length > 0,
    ai_model: typeof row.ai_model === "string" ? row.ai_model : null,
    ai_generated_at:
      typeof row.ai_generated_at === "string" ? row.ai_generated_at : null,
    ai_review_raw: row.ai_review_raw,
    ...finalDraft,
    published_language_edits: row.published_language_edits ?? null,
    published_scores: row.published_scores ?? null,
    published_content_feedback: row.published_content_feedback ?? null,
    published_teacher_comment:
      typeof row.published_teacher_comment === "string"
        ? row.published_teacher_comment
        : null,
    published_at: typeof row.published_at === "string" ? row.published_at : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null
  };
}

function buildUnsavedManualReview(
  taskType: "email" | "academic_discussion"
) {
  return {
    review_id: null,
    status: "pending" as const,
    has_ai_review: false,
    ai_model: null,
    ai_generated_at: null,
    ai_review_raw: null,
    ...buildManualWritingReviewDraft(taskType),
    published_language_edits: null,
    published_scores: null,
    published_content_feedback: null,
    published_teacher_comment: null,
    published_at: null,
    updated_at: null
  };
}

function databaseReadError() {
  return new WritingReviewWorkspaceServerError(
    "DATABASE_READ_FAILED",
    "暂时无法加载批改数据，请稍后重试。",
    500
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
