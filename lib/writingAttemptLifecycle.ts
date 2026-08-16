import type { WritingAttempt, WritingMode, WritingQuestion, WritingTaskType } from "@/lib/writing";

export type WritingDraftLookup = {
  data: WritingAttempt | null;
  error: WritingAttemptDatabaseError | null;
};

export type WritingDraftInsert = {
  data: WritingAttempt | null;
  error: WritingAttemptDatabaseError | null;
};

export type WritingAttemptDatabaseError = {
  code?: string | null;
  constraint?: string | null;
  details?: string | null;
  message: string;
};

export type WritingDraftRepository = {
  findDraft(input: {
    userId: string;
    taskType: WritingTaskType;
    questionId: string;
  }): Promise<WritingDraftLookup>;
  insertDraft(input: {
    userId: string;
    taskType: WritingTaskType;
    question: WritingQuestion;
    now: string;
    writingMode: WritingMode;
  }): Promise<WritingDraftInsert>;
};

export type GetOrCreateWritingDraftResult = {
  attempt: WritingAttempt;
  resumed: boolean;
  recoveredFromConflict: boolean;
};

export class WritingAttemptLifecycleError extends Error {
  cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "WritingAttemptLifecycleError";
    this.cause = cause;
  }
}

/**
 * Returns the one active draft for a student/question, or creates it. The database
 * uniqueness constraint remains the final concurrency guard; a losing insert re-reads
 * and resumes the winning draft.
 */
export async function getOrCreateWritingDraft(
  input: {
    userId: string;
    taskType: WritingTaskType;
    questionId: string;
    question: WritingQuestion;
    writingMode: WritingMode;
  },
  repository: WritingDraftRepository,
  now: () => Date = () => new Date()
): Promise<GetOrCreateWritingDraftResult> {
  const existing = await repository.findDraft(input);
  if (existing.error) throw safeDraftError(existing.error);
  if (existing.data) {
    return {
      attempt: existing.data,
      resumed: true,
      recoveredFromConflict: false
    };
  }

  const inserted = await repository.insertDraft({
    userId: input.userId,
    taskType: input.taskType,
    question: input.question,
    now: now().toISOString(),
    writingMode: input.writingMode
  });
  if (!inserted.error && inserted.data) {
    return {
      attempt: inserted.data,
      resumed: false,
      recoveredFromConflict: false
    };
  }

  if (isUniqueConstraintError(inserted.error)) {
    const winner = await repository.findDraft(input);
    if (winner.error) throw safeDraftError(winner.error);
    if (winner.data) {
      return {
        attempt: winner.data,
        resumed: true,
        recoveredFromConflict: true
      };
    }
  }

  throw safeDraftError(inserted.error);
}

export function isUniqueConstraintError(
  error: WritingAttemptDatabaseError | null | undefined
) {
  if (!error) return false;
  if (error.code === "23505") return true;
  const description = `${error.constraint ?? ""} ${error.message} ${error.details ?? ""}`;
  return description.includes("writing_attempts_one_draft_per_question");
}

function safeDraftError(error: WritingAttemptDatabaseError | null | undefined) {
  return new WritingAttemptLifecycleError("暂时无法进入写作练习，请稍后重试。", error);
}
