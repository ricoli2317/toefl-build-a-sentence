import type { WritingMode, WritingTaskType } from "./writing.ts";

export type SubmittedWritingAttemptSummary = {
  attempt_id: string;
  submitted_at: string | null;
  word_count: number;
  writing_mode: WritingMode | null;
  elapsed_seconds: number | null;
  has_published_review: boolean;
};

export type WritingSubmissionQuestionSummary = {
  question_id: string;
  set_title: string;
  display_name?: string;
  year_month: string;
};

type SubmittedAttemptRow = Omit<SubmittedWritingAttemptSummary, "has_published_review">;
type DatabaseResult<T> = { data: T | null; error: unknown };

export type WritingSubmissionHistoryRepository = {
  findOwnedSubmittedAttempts(input: {
    userId: string;
    taskType: WritingTaskType;
    questionId: string;
  }): Promise<DatabaseResult<SubmittedAttemptRow[]>>;
  findPublishedAttemptIds(attemptIds: string[]): Promise<DatabaseResult<string[]>>;
  findQuestion(input: {
    taskType: WritingTaskType;
    questionId: string;
  }): Promise<DatabaseResult<WritingSubmissionQuestionSummary>>;
};

export class WritingSubmissionHistoryError extends Error {
  code: "DATABASE_READ_FAILED" | "QUESTION_NOT_FOUND";
  status: number;

  constructor(
    code: "DATABASE_READ_FAILED" | "QUESTION_NOT_FOUND",
    message: string,
    status: number
  ) {
    super(message);
    this.name = "WritingSubmissionHistoryError";
    this.code = code;
    this.status = status;
  }
}

export async function loadWritingSubmissionHistory(
  input: { userId: string; taskType: WritingTaskType; questionId: string },
  repository: WritingSubmissionHistoryRepository
) {
  const [attemptResult, questionResult] = await Promise.all([
    repository.findOwnedSubmittedAttempts(input),
    repository.findQuestion(input)
  ]);
  if (attemptResult.error || questionResult.error) throw databaseError();
  if (!questionResult.data) {
    throw new WritingSubmissionHistoryError(
      "QUESTION_NOT_FOUND",
      "未找到对应的写作题目。",
      404
    );
  }
  const attempts = attemptResult.data ?? [];
  const publishedResult = attempts.length > 0
    ? await repository.findPublishedAttemptIds(attempts.map((attempt) => attempt.attempt_id))
    : { data: [], error: null };
  if (publishedResult.error) throw databaseError();
  return {
    question: questionResult.data,
    attempts: buildWritingSubmissionHistory(
      attempts,
      new Set(publishedResult.data ?? [])
    )
  };
}

export function buildWritingSubmissionHistory(
  attempts: SubmittedAttemptRow[],
  publishedAttemptIds: Set<string>
): SubmittedWritingAttemptSummary[] {
  return [...attempts]
    .sort(compareWritingSubmittedAttempts)
    .map((attempt) => ({
      ...attempt,
      has_published_review: publishedAttemptIds.has(attempt.attempt_id)
    }));
}

export function compareWritingSubmittedAttempts(
  left: Pick<SubmittedAttemptRow, "attempt_id" | "submitted_at">,
  right: Pick<SubmittedAttemptRow, "attempt_id" | "submitted_at">
) {
  const timeDifference = submittedTime(right.submitted_at) - submittedTime(left.submitted_at);
  return timeDifference || right.attempt_id.localeCompare(left.attempt_id);
}

function submittedTime(value: string | null) {
  const time = value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function databaseError() {
  return new WritingSubmissionHistoryError(
    "DATABASE_READ_FAILED",
    "暂时无法加载写作提交记录，请稍后重试。",
    500
  );
}
