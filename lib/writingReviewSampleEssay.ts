import type {
  EmailQuestion,
  WritingQuestion,
  WritingTaskType
} from "./writing.ts";
import {
  ACADEMIC_DISCUSSION_SCORING_GUIDE,
  EMAIL_SCORING_GUIDE
} from "./openrouterWritingReview.ts";

export const WRITING_SAMPLE_ESSAY_PROMPT_VERSION =
  "writing_sample_essay_prompt_v2" as const;
// Bump the version above whenever the 范文 Prompt contract changes.
// The sample essay is plain text; this stable label keeps the AI log schema_version
// column meaningful without pretending a structured schema exists.
export const WRITING_SAMPLE_ESSAY_SCHEMA_VERSION =
  "writing_sample_essay_text_v1" as const;
export const WRITING_SAMPLE_ESSAY_INSTRUCTION_MAX_LENGTH = 2000;

export type WritingSampleEssayAttempt = {
  attempt_id: string;
  assignment_id?: string | null;
  task_type: WritingTaskType;
  question_id: string;
  response_text: string;
  status: string;
};

export type WritingSampleEssayState = {
  instruction: string | null;
  draft: string | null;
  updated_at: string | null;
};

export type WritingSampleEssayRepository = {
  findAttempt(attemptId: string): Promise<WritingSampleEssayAttempt | null>;
  findQuestion(
    taskType: WritingTaskType,
    questionId: string,
    assignmentId?: string | null
  ): Promise<WritingQuestion | null>;
  /** Returns null when the attempt has no writing_reviews row yet. */
  readSampleEssayState(attemptId: string): Promise<WritingSampleEssayState | null>;
  /**
   * Overwrites the sample essay draft and latest instruction only when the row
   * still holds the state read before the AI request, so an older request can
   * never clobber a newer saved draft.
   */
  compareAndSaveSampleEssay(input: {
    attemptId: string;
    taskType: WritingTaskType;
    expected: WritingSampleEssayState | null;
    instruction: string;
    draft: string;
  }): Promise<WritingSampleEssayState>;
};

export type WritingSampleEssayDependencies = {
  repository: WritingSampleEssayRepository;
  requestAI(
    messages: Array<{ role: "system" | "user"; content: string }>,
    context: { taskType: WritingTaskType }
  ): Promise<{ content: string }>;
};

export type WritingSampleEssayErrorCode =
  | "ATTEMPT_NOT_FOUND"
  | "ATTEMPT_NOT_SUBMITTED"
  | "QUESTION_NOT_FOUND"
  | "INVALID_TEACHER_INSTRUCTION"
  | "SAMPLE_ESSAY_CONFLICT"
  | "AI_SERVICE_ERROR"
  | "AI_REQUEST_TIMEOUT"
  | "AI_RESPONSE_INVALID"
  | "DATABASE_READ_FAILED"
  | "SAMPLE_ESSAY_SAVE_FAILED";

export class WritingSampleEssayError extends Error {
  code: WritingSampleEssayErrorCode;
  status: number;
  cause?: unknown;

  constructor(
    code: WritingSampleEssayErrorCode,
    message: string,
    status: number,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "WritingSampleEssayError";
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

/**
 * The fixed student-facing task directions are not stored on the question row,
 * so the generation prompt spells them out next to the complete stored task.
 */
const ACADEMIC_DISCUSSION_TASK_DIRECTIONS = [
  "Your professor is teaching a class. Write a post responding to the professor's question.",
  "In your response, you should do the following: Express and support your opinion. Make a contribution to the discussion in your own words.",
  "An effective response will contain at least 100 words."
] as const;

const SAMPLE_ESSAY_GENERATION_RULES = `You are generating a model TOEFL response for a teacher.

Use the complete original task, the student's response, the teacher's instruction, and the task-specific 0–5 scoring rubric provided below. The teacher's instruction has highest priority.

Use the rubric to match the quality level requested by the teacher. If the teacher requests a specific score level, such as a 3-, 4-, or 5-level response, generate a response that realistically matches that level rather than automatically maximizing the score. If the teacher does not name a level, write a well-formed model response for the task based on the student's response and the rubric.

You may preserve useful ideas, reasoning, or organization from the student's response when appropriate. However, if the teacher explicitly asks for a completely new response, a response that does not use the student's ideas, or an equivalent instruction, do not rely on the student's response for content.

Return only the model response itself. Do not return analysis, a score, rubric explanation, feedback, a title, a word count, Markdown wrapping, "Model Response:", "Here is...", or JSON.`;

const DEFAULT_EMAIL_GENERATION_RULES = `Default generation rules (no teacher instruction was provided):
Generate a TOEFL Write an Email score-5 model response under the provided six-band 0–5 rubric. Target 120–140 English words in the response body.
Preserve the student's main ideas, intent, reasons, and key information. You may reorganize the response, add necessary details, and improve language and coherence. Correct errors; you do not need to preserve the original sentence by sentence.
Fulfill the current Email task requirements. If the student's response has no identifiable valid ideas, prioritize fulfilling the task rather than inventing views and attributing them to the student.`;

const DEFAULT_AD_GENERATION_RULES = `Default generation rules (no teacher instruction was provided):
Generate a TOEFL Academic Discussion score-5 model response under the provided six-band 0–5 rubric. Target 160–180 English words in the response body.
Preserve the student's core stance, main reasons, and direction of argument. You may deepen the argument, add appropriate examples, and improve organization.
Answer the professor's discussion question and fulfill the existing Academic Discussion task requirements. Responding to other students is optional, not required.
If the student's response has no identifiable valid ideas, prioritize fulfilling the task rather than inventing views and attributing them to the student.`;

export function buildWritingSampleEssayMessages(input: {
  taskType: WritingTaskType;
  question: WritingQuestion;
  responseText: string;
  teacherInstruction: string;
}) {
  const teacherInstruction = input.teacherInstruction.trim();
  const defaultRules = teacherInstruction
    ? ""
    : `\n\n${input.taskType === "email" ? DEFAULT_EMAIL_GENERATION_RULES : DEFAULT_AD_GENERATION_RULES}`;
  const rubric =
    input.taskType === "email"
      ? EMAIL_SCORING_GUIDE
      : ACADEMIC_DISCUSSION_SCORING_GUIDE;
  const taskDirections =
    input.taskType === "email"
      ? emailTaskDirections(input.question as EmailQuestion)
      : [...ACADEMIC_DISCUSSION_TASK_DIRECTIONS];
  return [
    {
      role: "system" as const,
      content: `${SAMPLE_ESSAY_GENERATION_RULES}${defaultRules}

Task-specific 0–5 scoring rubric:
${rubric}`
    },
    {
      role: "user" as const,
      content: JSON.stringify(
        {
          task_type: input.taskType,
          original_task: input.question,
          task_directions: taskDirections,
          student_response: input.responseText,
          teacher_instruction: teacherInstruction ? input.teacherInstruction : ""
        },
        null,
        2
      )
    }
  ];
}

function emailTaskDirections(question: EmailQuestion) {
  return [
    question.scenario,
    question.task_instruction,
    question.requirement_1,
    question.requirement_2,
    question.requirement_3,
    question.closing_instruction
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function parseWritingSampleEssayInstruction(body: unknown) {
  if (!isRecord(body) || typeof body.instruction !== "string") {
    throw failure("INVALID_TEACHER_INSTRUCTION", "请输入范文要求。", 400);
  }
  const instruction = body.instruction.trim();
  if (instruction.length > WRITING_SAMPLE_ESSAY_INSTRUCTION_MAX_LENGTH) {
    throw failure(
      "INVALID_TEACHER_INSTRUCTION",
      `范文要求不能超过 ${WRITING_SAMPLE_ESSAY_INSTRUCTION_MAX_LENGTH} 个字符。`,
      400
    );
  }
  return instruction;
}

export function parseWritingSampleEssayText(content: string) {
  const text = stripSingleCodeFence(typeof content === "string" ? content.trim() : "");
  if (!text) {
    throw failure("AI_RESPONSE_INVALID", "AI 返回的范文内容为空。", 502);
  }
  if (/⟦TPS_|TPS_UNIT:|TPS_INTERNAL_/.test(text)) {
    throw failure("AI_RESPONSE_INVALID", "AI 返回包含内部定位标记。", 502);
  }
  return text;
}

export async function generateWritingSampleEssay(
  attemptId: string,
  body: unknown,
  dependencies: WritingSampleEssayDependencies
) {
  const instruction = parseWritingSampleEssayInstruction(body);
  const attempt = await dependencies.repository.findAttempt(attemptId);
  if (!attempt) throw failure("ATTEMPT_NOT_FOUND", "未找到这条写作提交。", 404);
  if (attempt.status !== "submitted") {
    throw failure("ATTEMPT_NOT_SUBMITTED", "只有已提交的写作可以生成范文。", 409);
  }
  const question = await dependencies.repository.findQuestion(
    attempt.task_type,
    attempt.question_id,
    attempt.assignment_id
  );
  if (!question) throw failure("QUESTION_NOT_FOUND", "未找到对应的写作原题。", 404);

  const expected = await dependencies.repository.readSampleEssayState(attemptId);

  let aiResponse: { content: string };
  try {
    aiResponse = await dependencies.requestAI(
      buildWritingSampleEssayMessages({
        taskType: attempt.task_type,
        question,
        responseText: attempt.response_text,
        teacherInstruction: instruction
      }),
      { taskType: attempt.task_type }
    );
  } catch (error) {
    if (errorChainHasCode(error, "AI_REQUEST_TIMEOUT")) {
      throw failure("AI_REQUEST_TIMEOUT", "AI 范文生成超时，请稍后重试。", 504, error);
    }
    throw failure("AI_SERVICE_ERROR", "AI 服务暂时不可用，请稍后重试。", 502, error);
  }

  const draft = parseWritingSampleEssayText(aiResponse.content);
  const saved = await dependencies.repository.compareAndSaveSampleEssay({
    attemptId,
    taskType: attempt.task_type,
    expected,
    instruction,
    draft
  });
  return {
    instruction: saved.instruction ?? instruction,
    draft: saved.draft ?? draft,
    updated_at: saved.updated_at
  };
}

function stripSingleCodeFence(text: string) {
  const match = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  return match ? match[1].trim() : text;
}

function errorChainHasCode(error: unknown, code: string) {
  let current = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);
    if (isRecord(current) && current.code === code) return true;
    current = isRecord(current) ? current.cause : null;
  }
  return false;
}

function failure(
  code: WritingSampleEssayErrorCode,
  message: string,
  status: number,
  cause?: unknown
) {
  return new WritingSampleEssayError(code, message, status, cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
