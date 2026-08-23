import type { WritingQuestion, WritingTaskType } from "./writing.ts";
import type { InternalContentFeedbackV22 } from "./writingReviewSchemaV22.ts";
import {
  OpenRouterWritingReviewError,
  PROPOSED_REVISION_FIDELITY_RULES
} from "./openrouterWritingReview.ts";
import {
  ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES_V2,
  EMAIL_CONTENT_FEEDBACK_CATEGORIES_V2
} from "./writingReviewSchemaV2.ts";
import { buildWritingReviewTextUnits } from "./writingReviewTextUnits.ts";
import { buildAnchoredWritingResponse } from "./writingReviewAnchors.ts";

export const WRITING_FEEDBACK_PROMPT_MAX_LENGTH = 2000;
export const WRITING_FEEDBACK_REGEN_PROMPT_VERSION =
  "writing_feedback_regeneration_prompt_v2026_08_16_1" as const;
// Bump this version whenever the feedback-regeneration Prompt contract changes.
export const WRITING_FEEDBACK_REGEN_SCHEMA_VERSION =
  "writing_feedback_regeneration_v1" as const;

export const WRITING_FEEDBACK_REGENERATION_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "WritingFeedbackRegenerationResult",
  type: "object",
  additionalProperties: false,
  required: ["suggestion", "proposed_revision"],
  properties: {
    suggestion: { type: "string", minLength: 1 },
    proposed_revision: { type: "string", minLength: 1 }
  }
} as const;

export type WritingFeedbackRegenerationResult = {
  suggestion: string;
  proposed_revision: string;
};

export type RegenerationAttempt = {
  attempt_id: string;
  assignment_id?: string | null;
  task_type: WritingTaskType;
  question_id: string;
  response_text: string;
  status: string;
};

export type RegenerationReview = {
  content_feedback: unknown;
};

export type WritingFeedbackRegenerationRepository = {
  findAttempt(attemptId: string): Promise<RegenerationAttempt | null>;
  findReview(attemptId: string): Promise<RegenerationReview | null>;
  findQuestion(
    taskType: WritingTaskType,
    questionId: string,
    assignmentId?: string | null
  ): Promise<WritingQuestion | null>;
  updateContentFeedback(
    attemptId: string,
    contentFeedback: Record<string, unknown>
  ): Promise<{ updated_at: string }>;
};

export type WritingFeedbackRegenerationDependencies = {
  repository: WritingFeedbackRegenerationRepository;
  requestAI(
    messages: Array<{ role: "system" | "user"; content: string }>,
    context: { taskType: WritingTaskType }
  ): Promise<{ content: string }>;
  pipeline?: "legacy_v22" | "c3";
};

export type WritingFeedbackRegenerationErrorCode =
  | "ATTEMPT_NOT_FOUND"
  | "ATTEMPT_NOT_SUBMITTED"
  | "REVIEW_NOT_FOUND"
  | "QUESTION_NOT_FOUND"
  | "FEEDBACK_NOT_FOUND"
  | "TEACHER_FEEDBACK_UNSUPPORTED"
  | "LEGACY_FEEDBACK_UNSUPPORTED"
  | "FEEDBACK_POSITION_INVALID"
  | "INVALID_TEACHER_PROMPT"
  | "AI_SERVICE_ERROR"
  | "AI_REQUEST_TIMEOUT"
  | "AI_RESPONSE_INVALID"
  | "DATABASE_READ_FAILED"
  | "REVIEW_UPDATE_FAILED";

export class WritingFeedbackRegenerationError extends Error {
  code: WritingFeedbackRegenerationErrorCode;
  status: number;
  cause?: unknown;

  constructor(
    code: WritingFeedbackRegenerationErrorCode,
    message: string,
    status: number,
    cause?: unknown
  ) {
    super(message);
    this.name = "WritingFeedbackRegenerationError";
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

export async function regenerateWritingContentFeedback(
  attemptId: string,
  feedbackId: string,
  body: unknown,
  dependencies: WritingFeedbackRegenerationDependencies
) {
  const teacherPrompt = parseTeacherPrompt(body);
  const attempt = await dependencies.repository.findAttempt(attemptId);
  if (!attempt) throw failure("ATTEMPT_NOT_FOUND", "未找到这条写作提交。", 404);
  if (attempt.status !== "submitted") {
    throw failure("ATTEMPT_NOT_SUBMITTED", "只有已提交的写作可以重新生成反馈。", 409);
  }

  const review = await dependencies.repository.findReview(attemptId);
  if (!review) throw failure("REVIEW_NOT_FOUND", "未找到这条写作批改。", 404);
  const initial = findLocatedFeedback(
    review.content_feedback,
    feedbackId,
    attempt.response_text,
    attempt.task_type
  );
  const question = await dependencies.repository.findQuestion(
    attempt.task_type,
    attempt.question_id,
    attempt.assignment_id
  );
  if (!question) throw failure("QUESTION_NOT_FOUND", "未找到对应的写作原题。", 404);

  let aiResponse: { content: string };
  try {
    aiResponse = await dependencies.requestAI(
      (dependencies.pipeline === "c3" ? buildWritingFeedbackRegenerationC3Messages : buildWritingFeedbackRegenerationMessages)({
        taskType: attempt.task_type,
        question,
        responseText: attempt.response_text,
        feedback: initial.feedback,
        teacherPrompt
      }),
      { taskType: attempt.task_type }
    );
  } catch (error) {
    if (
      error instanceof OpenRouterWritingReviewError &&
      error.code === "AI_REQUEST_TIMEOUT"
    ) {
      throw failure(
        "AI_REQUEST_TIMEOUT",
        "AI 建议生成超时，请稍后重试。",
        504,
        error
      );
    }
    throw failure("AI_SERVICE_ERROR", "AI 服务暂时不可用，请稍后重试。", 502, error);
  }

  const regenerated = parseWritingFeedbackRegenerationResult(aiResponse.content);

  // Re-read immediately before updating so a stale page or a long AI request cannot
  // overwrite other teachers' newer working-draft changes.
  const latestReview = await dependencies.repository.findReview(attemptId);
  if (!latestReview) throw failure("REVIEW_NOT_FOUND", "未找到这条写作批改。", 404);
  const latest = findLocatedFeedback(
    latestReview.content_feedback,
    feedbackId,
    attempt.response_text,
    attempt.task_type
  );
  const updatedItem = {
    ...latest.feedback,
    suggestion: regenerated.suggestion,
    proposed_revision: regenerated.proposed_revision
  };
  const updatedContentFeedback = {
    ...latest.container,
    items: latest.items.map((item, index) =>
      index === latest.index ? updatedItem : item
    )
  };

  let saved: { updated_at: string };
  try {
    saved = await dependencies.repository.updateContentFeedback(
      attemptId,
      updatedContentFeedback
    );
  } catch (error) {
    throw failure("REVIEW_UPDATE_FAILED", "反馈更新失败，请稍后重试。", 500, error);
  }

  return {
    feedback_id: feedbackId,
    suggestion: regenerated.suggestion,
    proposed_revision: regenerated.proposed_revision,
    updated_at: saved.updated_at
  };
}

export function buildWritingFeedbackRegenerationMessages(input: {
  taskType: WritingTaskType;
  question: WritingQuestion;
  responseText: string;
  feedback: InternalContentFeedbackV22<string> & { example?: string };
  teacherPrompt: string;
}) {
  return [
    {
      role: "system" as const,
      content: `You are revising one existing TOEFL writing feedback item. You are not reviewing or regenerating the full essay. Return only suggestion and proposed_revision under the supplied JSON Schema.

Keep the existing feedback_id, category, original_sentence, issue, and text offsets conceptually unchanged. Do not change the nature of the identified issue. Generate only a new suggestion and directly applicable proposed_revision.

The suggestion must be specific, actionable, focused on the current sentence and issue, and directly follow the teacher's additional instruction. Keep it to normally 1–2 concise sentences. Do not rewrite or expand the whole essay.

${PROPOSED_REVISION_FIDELITY_RULES}

For this regeneration, the existing issue and the newly generated suggestion together must explain every material change in proposed_revision. If the teacher's additional instruction genuinely requires more changes, the new suggestion must explicitly explain those changes; never silently rewrite other wording.

The suggestion is explanatory feedback and must be written in Simplified Chinese, even when the teacher prompt is in English. proposed_revision must be written in English and contain only the final revised text, without labels, explanations, Chinese, or quotation marks. It must directly replace original_sentence, solve the identified issue, preserve the student's core intended meaning, and stay local to this feedback rather than rewriting the essay.`
    },
    {
      role: "user" as const,
      content: JSON.stringify(
        {
          task_type: input.taskType,
          original_question: input.question,
          response_text: input.responseText,
          current_feedback: {
            feedback_id: input.feedback.feedback_id,
            category: input.feedback.category,
            original_sentence: input.feedback.original_sentence,
            issue: input.feedback.issue,
            suggestion: input.feedback.suggestion,
            proposed_revision: input.feedback.proposed_revision
          },
          teacher_prompt: input.teacherPrompt
        },
        null,
        2
      )
    }
  ];
}

export function buildWritingFeedbackRegenerationC3Messages(input: {
  taskType: WritingTaskType;
  question: WritingQuestion;
  responseText: string;
  feedback: InternalContentFeedbackV22<string> & { example?: string };
  teacherPrompt: string;
}) {
  const anchored = buildAnchoredWritingResponse(input.responseText, buildWritingReviewTextUnits(input.responseText));
  return [{ role: "system" as const, content: "You are revising one existing TOEFL Content Feedback item only. Return only suggestion and proposed_revision under the supplied JSON Schema. TPS_UNIT markers are TPS metadata, not student writing: ignore and never mention, quote, count, or reproduce them. Read anchored_response as the complete response; unit boundaries are not sentence boundaries. Keep the target feedback's ID, category, location, and issue unchanged. Do not revise language edits, scores, other feedback, offsets, original text, or database fields." }, { role: "user" as const, content: JSON.stringify({ task_type: input.taskType, question: input.question, anchored_response: anchored.anchoredResponse, target_feedback: { category: input.feedback.category, issue: input.feedback.issue, suggestion: input.feedback.suggestion, proposed_revision: input.feedback.proposed_revision }, teacher_instruction: input.teacherPrompt }) }];
}

export function parseWritingFeedbackRegenerationResult(
  content: string
): WritingFeedbackRegenerationResult {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw failure("AI_RESPONSE_INVALID", "AI 返回的反馈格式无效。", 502, error);
  }
  if (!isRecord(value)) {
    throw failure("AI_RESPONSE_INVALID", "AI 返回的反馈格式无效。", 502);
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "proposed_revision" ||
    keys[1] !== "suggestion" ||
    typeof value.suggestion !== "string" ||
    value.suggestion.trim().length === 0 ||
    typeof value.proposed_revision !== "string" ||
    value.proposed_revision.trim().length === 0
  ) {
    throw failure("AI_RESPONSE_INVALID", "AI 返回的反馈格式无效。", 502);
  }
  if (/⟦TPS_|TPS_UNIT:|TPS_INTERNAL_/.test(value.suggestion) || /⟦TPS_|TPS_UNIT:|TPS_INTERNAL_/.test(value.proposed_revision)) {
    throw failure("AI_RESPONSE_INVALID", "AI 返回包含内部定位标记。", 502);
  }
  return {
    suggestion: value.suggestion,
    proposed_revision: value.proposed_revision
  };
}

function parseTeacherPrompt(body: unknown) {
  if (!isRecord(body) || typeof body.prompt !== "string") {
    throw failure("INVALID_TEACHER_PROMPT", "请输入新的反馈要求。", 400);
  }
  const prompt = body.prompt.trim();
  if (!prompt || prompt.length > WRITING_FEEDBACK_PROMPT_MAX_LENGTH) {
    throw failure(
      "INVALID_TEACHER_PROMPT",
      `反馈要求不能为空且不能超过 ${WRITING_FEEDBACK_PROMPT_MAX_LENGTH} 个字符。`,
      400
    );
  }
  return prompt;
}

function findLocatedFeedback(
  contentFeedback: unknown,
  feedbackId: string,
  responseText: string,
  taskType: WritingTaskType
) {
  if (!isRecord(contentFeedback) || !Array.isArray(contentFeedback.items)) {
    throw failure("REVIEW_NOT_FOUND", "批改工作稿中的内容反馈无效。", 500);
  }
  const index = contentFeedback.items.findIndex(
    (item) => isRecord(item) && item.feedback_id === feedbackId
  );
  if (index < 0) throw failure("FEEDBACK_NOT_FOUND", "未找到这条内容反馈。", 404);
  const value = contentFeedback.items[index];
  if (!isRecord(value)) throw failure("FEEDBACK_NOT_FOUND", "未找到这条内容反馈。", 404);
  if (value.source === "teacher") {
    throw failure(
      "TEACHER_FEEDBACK_UNSUPPORTED",
      "教师手动新增的反馈不支持 AI 重新生成。",
      409
    );
  }
  if (
    typeof value.original_sentence !== "string" ||
    !Number.isInteger(value.start) ||
    !Number.isInteger(value.end)
  ) {
    throw failure(
      "LEGACY_FEEDBACK_UNSUPPORTED",
      "旧版内容反馈不支持局部重新生成。",
      409
    );
  }
  if (
    typeof value.proposed_revision !== "string" ||
    value.proposed_revision.length === 0
  ) {
    throw failure(
      "LEGACY_FEEDBACK_UNSUPPORTED",
      "旧版内容反馈暂无可应用改写，不支持局部重新生成。",
      409
    );
  }
  if (
    typeof value.feedback_id !== "string" ||
    typeof value.category !== "string" ||
    typeof value.issue !== "string" ||
    typeof value.suggestion !== "string" ||
    typeof value.included !== "boolean"
  ) {
    throw failure("FEEDBACK_POSITION_INVALID", "内容反馈定位数据无效。", 409);
  }
  const allowedCategories =
    taskType === "email"
      ? EMAIL_CONTENT_FEEDBACK_CATEGORIES_V2
      : ACADEMIC_DISCUSSION_CONTENT_FEEDBACK_CATEGORIES_V2;
  if (!allowedCategories.includes(value.category as never)) {
    throw failure("FEEDBACK_POSITION_INVALID", "内容反馈类别无效。", 409);
  }
  const start = value.start as number;
  const end = value.end as number;
  if (
    start < 0 ||
    end <= start ||
    end > responseText.length ||
    responseText.slice(start, end) !== value.original_sentence
  ) {
    throw failure("FEEDBACK_POSITION_INVALID", "内容反馈的原文定位已经失效。", 409);
  }
  return {
    container: contentFeedback,
    items: contentFeedback.items,
    index,
    feedback: value as InternalContentFeedbackV22<string> & { example?: string }
  };
}

function failure(
  code: WritingFeedbackRegenerationErrorCode,
  message: string,
  status: number,
  cause?: unknown
) {
  return new WritingFeedbackRegenerationError(code, message, status, cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
