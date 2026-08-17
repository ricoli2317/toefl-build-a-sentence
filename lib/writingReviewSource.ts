import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AcademicDiscussionQuestion,
  EmailQuestion,
  WritingAttempt,
  WritingTaskType
} from "@/lib/writing";
import { isWritingQuestionSnapshot } from "./writingAssignments.ts";

export type WritingReviewSourceAttempt = Pick<
  WritingAttempt,
  | "attempt_id"
  | "assignment_id"
  | "user_id"
  | "task_type"
  | "question_id"
  | "set_id"
  | "response_text"
  | "word_count"
  | "writing_mode"
  | "elapsed_seconds"
  | "overtime_ranges"
  | "status"
  | "submitted_at"
>;

export type WritingReviewSourceQuestion = EmailQuestion | AcademicDiscussionQuestion;

export type WritingReviewSourceStage =
  | "writing_attempt"
  | "writing_assignment"
  | "email_question"
  | "academic_discussion_question";

type SupabaseSourceError = {
  code?: string | null;
  message: string;
};

export class WritingReviewSourceLoadError extends Error {
  stage: WritingReviewSourceStage;
  supabaseCode: string | null;

  constructor(stage: WritingReviewSourceStage, error: SupabaseSourceError) {
    const code = error.code?.trim() || "unknown";
    super(
      `Supabase query failed (stage: ${stage}, code: ${code}, message: ${error.message})`
    );
    this.name = "WritingReviewSourceLoadError";
    this.stage = stage;
    this.supabaseCode = error.code?.trim() || null;
  }
}

const WRITING_REVIEW_ATTEMPT_FIELDS =
  "attempt_id,assignment_id,user_id,task_type,question_id,set_id,response_text,word_count,status,writing_mode,elapsed_seconds,overtime_ranges,submitted_at";

export function writingReviewQuestionFields(taskType: WritingTaskType) {
  return taskType === "email"
    ? "question_id,set_id,set_title,year_month,source_labels,scenario,task_instruction,requirement_1,requirement_2,requirement_3,closing_instruction,recipient,subject"
    : "question_id,set_id,set_title,year_month,source_labels,professor_name,professor_prompt,student_1_name,student_1_response,student_2_name,student_2_response";
}

export async function readWritingAttemptForReview(
  supabase: SupabaseClient,
  attemptId: string
) {
  const { data, error } = await supabase
    .from("writing_attempts")
    .select(WRITING_REVIEW_ATTEMPT_FIELDS)
    .eq("attempt_id", attemptId)
    .maybeSingle();

  return { data: data as WritingReviewSourceAttempt | null, error };
}

export async function readWritingQuestionForReview(
  supabase: SupabaseClient,
  taskType: WritingTaskType,
  questionId: string,
  assignmentId?: string | null
) {
  if (assignmentId) {
    const { data, error } = await supabase
      .from("writing_assignments")
      .select("task_type,question_source,question_snapshot")
      .eq("assignment_id", assignmentId)
      .maybeSingle();
    if (error) return { data: null, error, questionSource: null };
    if (data?.task_type === taskType && isWritingQuestionSnapshot(taskType, data.question_snapshot)) {
      return {
        data: data.question_snapshot as WritingReviewSourceQuestion,
        error: null,
        questionSource: data.question_source === "custom" ? "custom" as const : "question_bank" as const
      };
    }
    return { data: null, error: null, questionSource: null };
  }
  const table =
    taskType === "email" ? "email_questions" : "academic_discussion_questions";
  const { data, error } = await supabase
    .from(table)
    .select(writingReviewQuestionFields(taskType))
    .eq("question_id", questionId)
    .maybeSingle();

  return {
    data: data as WritingReviewSourceQuestion | null,
    error,
    questionSource: "question_bank" as const
  };
}

/** Loads the read-only source shared by local comparison tooling. */
export async function loadWritingReviewComparisonSource(
  supabase: SupabaseClient,
  attemptId: string
) {
  const attemptResult = await readWritingAttemptForReview(supabase, attemptId);
  if (attemptResult.error) {
    throw new WritingReviewSourceLoadError("writing_attempt", attemptResult.error);
  }

  const attempt = attemptResult.data;
  if (!attempt) throw new Error(`Writing attempt not found: ${attemptId}`);
  if (attempt.status !== "submitted") {
    throw new Error("The writing attempt is not submitted.");
  }
  if (
    attempt.task_type !== "email" &&
    attempt.task_type !== "academic_discussion"
  ) {
    throw new Error(`Unsupported writing task_type: ${String(attempt.task_type)}`);
  }

  const questionResult = await readWritingQuestionForReview(
    supabase,
    attempt.task_type,
    attempt.question_id,
    attempt.assignment_id
  );
  if (questionResult.error) {
    throw new WritingReviewSourceLoadError(
      attempt.task_type === "email"
        ? "email_question"
        : "academic_discussion_question",
      questionResult.error
    );
  }
  if (!questionResult.data) {
    throw new Error(`Original writing question not found: ${attempt.question_id}`);
  }

  return { attempt, question: questionResult.data };
}
