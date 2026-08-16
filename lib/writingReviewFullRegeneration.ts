import type { WritingQuestion, WritingTaskType } from "./writing.ts";
import type {
  AIReviewRawResultV22,
  AIReviewResultV22
} from "./writingReviewSchemaV22.ts";
import type {
  WorkingContentFeedbackItem,
  WorkingLanguageEdit
} from "./writingReviewWorkspace.ts";

export type FullRegenerationAttempt = {
  attempt_id: string;
  task_type: WritingTaskType;
  question_id: string;
  response_text: string;
  status: string;
};

export type FullRegenerationReview = {
  review_id: string;
  status: "reviewing" | "published";
  ai_review_raw?: unknown;
  language_edits?: unknown;
  scores?: unknown;
  content_feedback?: unknown;
  teacher_comment?: unknown;
};

export type FullRegenerationUpdate = {
  ai_model: string;
  ai_review_raw: AIReviewRawResultV22;
  ai_generated_at: string;
  language_edits: WorkingLanguageEdit[];
  scores: AIReviewResultV22["scores"];
  content_feedback: {
    items: WorkingContentFeedbackItem[];
    overall_feedback: string;
  };
  teacher_comment: string;
};

export type WritingReviewFullRegenerationRepository = {
  findAttempt(attemptId: string): Promise<FullRegenerationAttempt | null>;
  findReview(attemptId: string): Promise<FullRegenerationReview | null>;
  findQuestion(
    taskType: WritingTaskType,
    questionId: string
  ): Promise<WritingQuestion | null>;
  updateWorkingReview(
    attemptId: string,
    update: FullRegenerationUpdate
  ): Promise<{ review_id: string }>;
};

export type WritingReviewFullRegenerationDependencies = {
  repository: WritingReviewFullRegenerationRepository;
  requestAI(input: {
    taskType: WritingTaskType;
    question: Record<string, unknown>;
    responseText: string;
  }): Promise<{ content: string; model: string }>;
  parseReview(value: unknown, responseText: string): AIReviewResultV22;
  now?: () => Date;
};

export type WritingReviewFullRegenerationErrorCode =
  | "ATTEMPT_NOT_FOUND"
  | "ATTEMPT_NOT_SUBMITTED"
  | "REVIEW_NOT_FOUND"
  | "QUESTION_NOT_FOUND"
  | "AI_RESPONSE_INVALID"
  | "REVIEW_UPDATE_FAILED";

export class WritingReviewFullRegenerationError extends Error {
  code: WritingReviewFullRegenerationErrorCode;
  status: number;
  cause?: unknown;

  constructor(
    code: WritingReviewFullRegenerationErrorCode,
    message: string,
    status: number,
    cause?: unknown
  ) {
    super(message);
    this.name = "WritingReviewFullRegenerationError";
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

export async function regenerateFullWritingReview(
  attemptId: string,
  dependencies: WritingReviewFullRegenerationDependencies
) {
  const attempt = await dependencies.repository.findAttempt(attemptId);
  if (!attempt) throw failure("ATTEMPT_NOT_FOUND", "未找到这条写作提交。", 404);
  if (attempt.status !== "submitted") {
    throw failure("ATTEMPT_NOT_SUBMITTED", "只有已提交的写作可以重新生成初批。", 409);
  }
  const existing = await dependencies.repository.findReview(attemptId);
  if (!existing) throw failure("REVIEW_NOT_FOUND", "未找到这条写作批改。", 404);
  const question = await dependencies.repository.findQuestion(
    attempt.task_type,
    attempt.question_id
  );
  if (!question) throw failure("QUESTION_NOT_FOUND", "未找到对应的写作原题。", 404);

  const aiResponse = await dependencies.requestAI({
    taskType: attempt.task_type,
    question: question as unknown as Record<string, unknown>,
    responseText: attempt.response_text
  });
  let raw: unknown;
  let review: AIReviewResultV22;
  try {
    raw = JSON.parse(aiResponse.content) as unknown;
    review = dependencies.parseReview(raw, attempt.response_text);
  } catch (error) {
    throw failure(
      "AI_RESPONSE_INVALID",
      "新的 AI 初批未通过 v2.2 格式或原文定位校验，原批改未改变。",
      502,
      error
    );
  }
  if (review.schema_version !== "2.2" || review.task_type !== attempt.task_type) {
    throw failure(
      "AI_RESPONSE_INVALID",
      "新的 AI 初批与当前作文不匹配，原批改未改变。",
      502
    );
  }

  const aiGeneratedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const mergedItems = mergeRegeneratedWritingReviewItems(
    attempt.response_text,
    review.language_edits,
    review.content_feedback,
    existing
  );
  const teacherState = mergeRegeneratedWritingReviewTeacherState(
    review.scores,
    existing
  );
  const update: FullRegenerationUpdate = {
    ai_model: aiResponse.model,
    ai_review_raw: structuredClone(raw) as AIReviewRawResultV22,
    ai_generated_at: aiGeneratedAt,
    language_edits: mergedItems.language_edits,
    scores: teacherState.scores,
    content_feedback: {
      items: mergedItems.content_feedback,
      overall_feedback: review.overall_feedback
    },
    teacher_comment: teacherState.teacher_comment
  };
  try {
    await dependencies.repository.updateWorkingReview(attemptId, update);
  } catch (error) {
    throw failure(
      "REVIEW_UPDATE_FAILED",
      "新的 AI 初批保存失败，原批改未改变。",
      500,
      error
    );
  }
  return {
    reviewId: existing.review_id,
    status: existing.status,
    aiModel: aiResponse.model,
    aiGeneratedAt,
    update
  };
}

export function mergeRegeneratedWritingReviewTeacherState(
  newScores: AIReviewResultV22["scores"],
  existing: Pick<
    FullRegenerationReview,
    "ai_review_raw" | "scores" | "teacher_comment"
  >
) {
  const scores = structuredClone(newScores);
  const existingScores = isRecord(existing.scores) ? existing.scores : null;
  const existingOfficial = isRecord(existingScores?.official_score)
    ? existingScores.official_score
    : null;
  if (isRubricScore(existingOfficial?.teacher_score)) {
    scores.official_score.teacher_score = existingOfficial.teacher_score;
  }
  const rawReferences = readRawScoreReferences(existing.ai_review_raw);
  scores.official_score.rationale = mergeFinalScoreReference({
    current:
      typeof existingOfficial?.rationale === "string"
        ? existingOfficial.rationale
        : null,
    original: rawReferences.official,
    regenerated: scores.official_score.rationale,
    reviewHasAi: existing.ai_review_raw !== null && existing.ai_review_raw !== undefined
  });
  const existingDimensions = isRecord(existingScores?.dimension_scores)
    ? existingScores.dimension_scores
    : null;
  Object.entries(scores.dimension_scores).forEach(([key, dimension]) => {
    const existingDimension = isRecord(existingDimensions?.[key])
      ? existingDimensions[key]
      : null;
    if (isRubricScore(existingDimension?.teacher_score)) {
      dimension.teacher_score = existingDimension.teacher_score;
    }
    dimension.ai_basis = mergeFinalScoreReference({
      current:
        typeof existingDimension?.ai_basis === "string"
          ? existingDimension.ai_basis
          : null,
      original: rawReferences.dimensions[key] ?? null,
      regenerated: dimension.ai_basis,
      reviewHasAi:
        existing.ai_review_raw !== null && existing.ai_review_raw !== undefined
    });
  });
  return {
    scores,
    teacher_comment:
      typeof existing.teacher_comment === "string" ? existing.teacher_comment : ""
  };
}

function readRawScoreReferences(value: unknown) {
  if (!isRecord(value)) {
    return { official: null, dimensions: {} as Record<string, string> };
  }
  const scores = isRecord(value.scores) ? value.scores : null;
  const officialScore = isRecord(scores?.official_score)
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
    official:
      typeof officialScore?.rationale === "string"
        ? officialScore.rationale
        : null,
    dimensions: dimensions as Record<string, string>
  };
}

function mergeFinalScoreReference(input: {
  current: string | null;
  original: string | null;
  regenerated: string;
  reviewHasAi: boolean;
}) {
  if (input.current === null) return input.regenerated;
  if (!input.reviewHasAi) {
    return input.current.trim().length > 0 ? input.current : input.regenerated;
  }
  if (input.original === null || input.current !== input.original) {
    return input.current;
  }
  return input.regenerated;
}

export function mergeRegeneratedWritingReviewItems(
  responseText: string,
  newAiEdits: AIReviewResultV22["language_edits"],
  newAiFeedback: AIReviewResultV22["content_feedback"],
  existing: Pick<FullRegenerationReview, "language_edits" | "content_feedback">
) {
  const teacherEdits = readTeacherLanguageEdits(
    existing.language_edits,
    responseText
  );
  const teacherFeedback = readTeacherFeedback(existing.content_feedback);
  const aiEdits = newAiEdits
    .filter(
      (edit) =>
        !teacherEdits.some(
          (teacher) => edit.start < teacher.end && edit.end > teacher.start
        )
    )
    .map((edit) => ({ ...edit, source: "ai" as const }));
  return {
    language_edits: [...teacherEdits, ...aiEdits].sort(
      (left, right) => left.start - right.start || left.end - right.end
    ),
    content_feedback: [
      ...newAiFeedback.map((item) => ({ ...item, source: "ai" as const })),
      ...teacherFeedback
    ]
  };
}

function readTeacherLanguageEdits(value: unknown, responseText: string) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw failure(
      "AI_RESPONSE_INVALID",
      "现有教师语言修改格式无效，原批改未改变。",
      500
    );
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || item.source !== "teacher") return [];
    if (
      !Number.isInteger(item.start) ||
      !Number.isInteger(item.end) ||
      typeof item.original_text !== "string"
    ) {
      throw failure(
        "AI_RESPONSE_INVALID",
        "现有教师语言修改格式无效，原批改未改变。",
        500
      );
    }
    const start = item.start as number;
    const end = item.end as number;
    if (
      start < 0 ||
      end <= start ||
      end > responseText.length ||
      responseText.slice(start, end) !== item.original_text
    ) {
      throw failure(
        "AI_RESPONSE_INVALID",
        "现有教师语言修改定位失效，原批改未改变。",
        500
      );
    }
    return [structuredClone(item) as WorkingLanguageEdit];
  });
}

function readTeacherFeedback(value: unknown) {
  if (value === undefined) return [];
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw failure(
      "AI_RESPONSE_INVALID",
      "现有教师内容反馈格式无效，原批改未改变。",
      500
    );
  }
  return value.items.flatMap((item) =>
    isRecord(item) && item.source === "teacher"
      ? [structuredClone(item) as WorkingContentFeedbackItem]
      : []
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRubricScore(value: unknown): value is 0 | 1 | 2 | 3 | 4 | 5 {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 5;
}

function failure(
  code: WritingReviewFullRegenerationErrorCode,
  message: string,
  status: number,
  cause?: unknown
) {
  return new WritingReviewFullRegenerationError(code, message, status, cause);
}
