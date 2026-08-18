import type {
  AcademicDiscussionQuestion,
  EmailQuestion,
  WritingAttempt,
  WritingTaskType
} from "@/lib/writing";
import type { AIReviewResult } from "@/lib/writingReviewSchema";
import type {
  AIReviewRawResultV2,
  AIReviewResultV2
} from "@/lib/writingReviewSchemaV2";
import type {
  AIReviewRawResultV21,
  AIReviewResultV21
} from "@/lib/writingReviewSchemaV21";
import type {
  AIReviewRawResultV22,
  AIReviewResultV22
} from "@/lib/writingReviewSchemaV22";

export type ReviewableWritingAttempt = Pick<
  WritingAttempt,
  "attempt_id" | "task_type" | "question_id" | "response_text" | "status"
> & { assignment_id?: string | null };

export type ReviewQuestion = EmailQuestion | AcademicDiscussionQuestion;

export type WritingReviewInsert = {
  attempt_id: string;
  task_type: WritingTaskType;
  status: "reviewing";
  ai_model: string;
  ai_review_raw: AIReviewResult | AIReviewRawResultV2 | AIReviewRawResultV21 | AIReviewRawResultV22;
  ai_generated_at: string;
  language_edits:
    | AIReviewResult["language_edits"]
    | AIReviewResultV2["language_edits"]
    | AIReviewResultV21["language_edits"]
    | AIReviewResultV22["language_edits"];
  scores: AIReviewResult["score"] | AIReviewResultV2["scores"] | AIReviewResultV21["scores"] | AIReviewResultV22["scores"];
  content_feedback:
    | {
        rubric_analysis: AIReviewResult["rubric_analysis"];
        items: AIReviewResult["content_feedback"];
        overall_feedback: string;
      }
    | {
        items: AIReviewResultV2["content_feedback"] | AIReviewResultV21["content_feedback"] | AIReviewResultV22["content_feedback"];
        overall_feedback: string;
      };
  teacher_comment: "";
};

export type WritingReviewRepository = {
  findAttempt(attemptId: string): Promise<ReviewableWritingAttempt | null>;
  findExistingReview(attemptId: string): Promise<ExistingWritingReview | null>;
  findQuestion(
    taskType: WritingTaskType,
    questionId: string,
    assignmentId?: string | null
  ): Promise<ReviewQuestion | null>;
  insertReview(input: WritingReviewInsert): Promise<{ review_id: string }>;
};

export type ExistingWritingReview = {
  review_id: string;
  status?: "reviewing" | "published";
  ai_model?: string | null;
  ai_generated_at?: string | null;
};

export class WritingReviewPersistenceConflictError extends Error {
  code = "REVIEW_SAVE_FAILED" as const;
  status = 500;
  cause?: unknown;

  constructor(cause?: unknown) {
    super("Another request may have saved this writing review concurrently.");
    this.name = "WritingReviewPersistenceConflictError";
    this.cause = cause;
  }
}

export type WritingReviewGenerationDependencies = {
  repository: WritingReviewRepository;
  requestAI(input: {
    taskType: WritingTaskType;
    question: Record<string, unknown>;
    responseText: string;
  }): Promise<{ content: string; model: string }>;
  parseReview(
    value: unknown,
    responseText: string
  ): AIReviewResult | AIReviewResultV2 | AIReviewResultV21 | AIReviewResultV22;
  now?: () => Date;
};

export function writingReviewAttemptResponseText(
  attempt: ReviewableWritingAttempt | null
) {
  return attempt?.response_text ?? "";
}

export type WritingReviewGenerationErrorCode =
  | "ATTEMPT_NOT_FOUND"
  | "ATTEMPT_NOT_SUBMITTED"
  | "REVIEW_ALREADY_EXISTS"
  | "QUESTION_NOT_FOUND"
  | "AI_RESPONSE_INVALID";

export class WritingReviewGenerationError extends Error {
  code: WritingReviewGenerationErrorCode;
  status: number;
  cause?: unknown;

  constructor(
    code: WritingReviewGenerationErrorCode,
    message: string,
    status: number,
    cause?: unknown
  ) {
    super(message);
    this.name = "WritingReviewGenerationError";
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

export async function generateAndSaveWritingReview(
  attemptId: string,
  dependencies: WritingReviewGenerationDependencies
) {
  const attempt = await dependencies.repository.findAttempt(attemptId);
  if (!attempt) {
    throw new WritingReviewGenerationError(
      "ATTEMPT_NOT_FOUND",
      "Writing attempt not found.",
      404
    );
  }
  if (attempt.status !== "submitted") {
    throw new WritingReviewGenerationError(
      "ATTEMPT_NOT_SUBMITTED",
      "Only submitted writing attempts can be reviewed.",
      409
    );
  }

  const existingReview = await dependencies.repository.findExistingReview(attemptId);
  if (existingReview) {
    return reusedWritingReviewResult(attempt, existingReview, false);
  }

  const question = await dependencies.repository.findQuestion(
    attempt.task_type,
    attempt.question_id,
    attempt.assignment_id
  );
  if (!question) {
    throw new WritingReviewGenerationError(
      "QUESTION_NOT_FOUND",
      "The original writing question could not be found.",
      404
    );
  }

  const aiResponse = await dependencies.requestAI({
    taskType: attempt.task_type,
    question: question as unknown as Record<string, unknown>,
    responseText: attempt.response_text
  });

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(aiResponse.content) as unknown;
  } catch (error) {
    throw new WritingReviewGenerationError(
      "AI_RESPONSE_INVALID",
      "AI response content was not valid JSON.",
      502,
      error
    );
  }

  let review: AIReviewResult | AIReviewResultV2 | AIReviewResultV21 | AIReviewResultV22;
  try {
    review = dependencies.parseReview(parsedJson, attempt.response_text);
  } catch (error) {
    throw new WritingReviewGenerationError(
      "AI_RESPONSE_INVALID",
      "AI response failed raw schema or exact text-location validation.",
      502,
      error
    );
  }

  if (review.task_type !== attempt.task_type) {
    throw new WritingReviewGenerationError(
      "AI_RESPONSE_INVALID",
      "AI response task_type did not match the writing attempt.",
      502
    );
  }

  const aiGeneratedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const reviewData: WritingReviewInsert =
    review.schema_version === "2.0" || review.schema_version === "2.1" || review.schema_version === "2.2"
      ? {
          attempt_id: attempt.attempt_id,
          task_type: attempt.task_type,
          status: "reviewing",
          ai_model: aiResponse.model,
          ai_review_raw: structuredClone(parsedJson) as AIReviewRawResultV2 | AIReviewRawResultV21 | AIReviewRawResultV22,
          ai_generated_at: aiGeneratedAt,
          language_edits: review.language_edits.map((edit) => ({
            ...edit,
            source: "ai" as const
          })),
          scores: review.scores,
          content_feedback: {
            items: review.content_feedback.map((item) => ({
              ...item,
              source: "ai" as const
            })) as typeof review.content_feedback,
            overall_feedback: review.overall_feedback
          },
          teacher_comment: ""
        }
      : {
          attempt_id: attempt.attempt_id,
          task_type: attempt.task_type,
          status: "reviewing",
          ai_model: aiResponse.model,
          ai_review_raw: review,
          ai_generated_at: aiGeneratedAt,
          language_edits: review.language_edits.map((edit) => ({
            ...edit,
            source: "ai" as const
          })),
          scores: review.score,
          content_feedback: {
            rubric_analysis: review.rubric_analysis,
            items: review.content_feedback.map((item) => ({
              ...item,
              source: "ai" as const
            })) as typeof review.content_feedback,
            overall_feedback: review.overall_feedback
          },
          teacher_comment: ""
        };
  let savedReview: { review_id: string };
  try {
    savedReview = await dependencies.repository.insertReview(reviewData);
  } catch (error) {
    if (!(error instanceof WritingReviewPersistenceConflictError)) throw error;
    const concurrentReview = await dependencies.repository.findExistingReview(attemptId);
    if (!concurrentReview) throw error;
    return reusedWritingReviewResult(attempt, concurrentReview, true);
  }

  return {
    reviewId: savedReview.review_id,
    attemptId: attempt.attempt_id,
    status: "reviewing" as const,
    aiModel: aiResponse.model,
    aiGeneratedAt,
    reusedExistingReview: false,
    persistenceRaceRecovered: false
  };
}

function reusedWritingReviewResult(
  attempt: ReviewableWritingAttempt,
  review: ExistingWritingReview,
  persistenceRaceRecovered: boolean
) {
  return {
    reviewId: review.review_id,
    attemptId: attempt.attempt_id,
    status: review.status ?? ("reviewing" as const),
    aiModel: review.ai_model ?? null,
    aiGeneratedAt: review.ai_generated_at ?? null,
    reusedExistingReview: true,
    persistenceRaceRecovered
  };
}
