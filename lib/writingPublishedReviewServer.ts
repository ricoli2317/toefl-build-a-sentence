import type { SupabaseClient } from "@supabase/supabase-js";
import { WRITING_TASK_CONFIG, type WritingQuestion } from "./writing.ts";
import {
  hydratePublishedWritingReviewSnapshot,
  toStudentPublishedWritingReview
} from "./writingPublishedReview.ts";

const ATTEMPT_FIELDS =
  "attempt_id,user_id,task_type,question_id,set_id,response_text,word_count,status,overtime_ranges,submitted_at";
const PUBLISHED_REVIEW_FIELDS =
  "attempt_id,status,published_language_edits,published_scores,published_content_feedback,published_teacher_comment,published_at";

export type StudentPublishedReviewErrorCode =
  | "ATTEMPT_NOT_FOUND"
  | "REVIEW_NOT_PUBLISHED"
  | "QUESTION_NOT_FOUND"
  | "PUBLISHED_REVIEW_INVALID"
  | "DATABASE_READ_FAILED";

export class StudentPublishedReviewError extends Error {
  code: StudentPublishedReviewErrorCode;
  status: number;

  constructor(
    code: StudentPublishedReviewErrorCode,
    message: string,
    status: number
  ) {
    super(message);
    this.name = "StudentPublishedReviewError";
    this.code = code;
    this.status = status;
  }
}

export async function loadStudentPublishedWritingReview(
  supabase: SupabaseClient,
  userId: string,
  attemptId: string
) {
  const attemptResult = await supabase
    .from("writing_attempts")
    .select(ATTEMPT_FIELDS)
    .eq("attempt_id", attemptId)
    .eq("user_id", userId)
    .eq("status", "submitted")
    .maybeSingle();
  if (attemptResult.error) throw databaseError();
  if (!attemptResult.data) {
    throw new StudentPublishedReviewError(
      "ATTEMPT_NOT_FOUND",
      "未找到这条写作提交。",
      404
    );
  }
  const attempt = attemptResult.data as Record<string, any>;

  const [reviewResult, questionResult] = await Promise.all([
    supabase
      .from("writing_reviews")
      .select(PUBLISHED_REVIEW_FIELDS)
      .eq("attempt_id", attemptId)
      .eq("status", "published")
      .maybeSingle(),
    supabase
      .from(WRITING_TASK_CONFIG[attempt.task_type as "email" | "academic_discussion"].questionTable)
      .select("*")
      .eq("question_id", attempt.question_id)
      .maybeSingle()
  ]);
  if (reviewResult.error || questionResult.error) throw databaseError();
  if (!reviewResult.data) {
    throw new StudentPublishedReviewError(
      "REVIEW_NOT_PUBLISHED",
      "这次写作的批改尚未发布。",
      404
    );
  }
  if (!questionResult.data) {
    throw new StudentPublishedReviewError(
      "QUESTION_NOT_FOUND",
      "未找到对应的写作题目。",
      404
    );
  }
  const review = reviewResult.data as Record<string, unknown>;
  try {
    const snapshot = hydratePublishedWritingReviewSnapshot({
      taskType: attempt.task_type,
      responseText: attempt.response_text,
      publishedLanguageEdits: review.published_language_edits,
      publishedScores: review.published_scores,
      publishedContentFeedback: review.published_content_feedback,
      publishedTeacherComment: review.published_teacher_comment,
      publishedAt: review.published_at
    });
    return {
      attempt: {
        attempt_id: attempt.attempt_id,
        task_type: attempt.task_type,
        response_text: attempt.response_text,
        overtime_ranges: attempt.overtime_ranges,
        word_count: attempt.word_count,
        submitted_at: attempt.submitted_at
      },
      question: questionResult.data as WritingQuestion,
      review: toStudentPublishedWritingReview(snapshot)
    };
  } catch (error) {
    throw new StudentPublishedReviewError(
      "PUBLISHED_REVIEW_INVALID",
      "已发布批改数据格式无效。",
      500
    );
  }
}

function databaseError() {
  return new StudentPublishedReviewError(
    "DATABASE_READ_FAILED",
    "暂时无法加载批改结果，请稍后重试。",
    500
  );
}
