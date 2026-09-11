import type { ReadingAnswerState } from "./practiceState.ts";
import type { ReadingModule } from "./types.ts";

export type ReadingFullSetAttemptStatus = "in_progress" | "completed";
export type ReadingFullSetModuleStatus = "active" | "submitted";
export type ReadingFullSetSubmissionReason = "manual" | "timeout" | null;

export type ReadingFullSetModuleAttemptSummary = {
  moduleAttemptId: string;
  moduleNumber: 1 | 2;
  status: ReadingFullSetModuleStatus;
  timeLimitSeconds: number;
  startedAt: string;
  deadlineAt: string;
  submittedAt: string | null;
  submissionReason: ReadingFullSetSubmissionReason;
  answerRevision: number;
};

export type ReadingFullSetAttemptSummary = {
  attemptId: string;
  fullSetId: string;
  status: ReadingFullSetAttemptStatus;
  currentModule: 1 | 2;
  startedAt: string;
  completedAt: string | null;
  serverNow: string;
  module1: ReadingFullSetModuleAttemptSummary;
  module2: ReadingFullSetModuleAttemptSummary | null;
  created?: boolean;
};

export type ReadingFullSetAttemptPhase =
  | "module_1_active"
  | "module_2_ready"
  | "module_2_active"
  | "completed";

export type ReadingFullSetRunnerOccurrence = {
  occurrenceId: string;
  logicalItemId: string;
  taskType: ReadingModule;
  sourceQuestionStart: number;
  sourceQuestionEnd: number;
};

export type ReadingFullSetRunnerPayload = {
  attempt: ReadingFullSetAttemptSummary;
  occurrences: ReadingFullSetRunnerOccurrence[];
  title: string;
};

export type ReadingFullSetOccurrencePracticePayload = {
  answerRevision: number;
  answers: ReadingAnswerState;
  occurrence: ReadingFullSetRunnerOccurrence;
  practice: import("./studentPractice.ts").StudentReadingPracticePayload;
  questionTimes: Record<string, number>;
};

export type ReadingFullSetRunnerPosition = {
  occurrenceIndex: number;
  questionIndex: number;
};

export function readingFullSetAttemptPhase(
  attempt: ReadingFullSetAttemptSummary
): ReadingFullSetAttemptPhase {
  if (attempt.status === "completed") return "completed";
  if (attempt.module2?.status === "active") return "module_2_active";
  if (attempt.module1.status === "submitted") return "module_2_ready";
  return "module_1_active";
}

export function readingFullSetActiveModuleAttempt(
  attempt: ReadingFullSetAttemptSummary
): ReadingFullSetModuleAttemptSummary | null {
  const phase = readingFullSetAttemptPhase(attempt);
  if (phase === "module_1_active") return attempt.module1;
  if (phase === "module_2_active") return attempt.module2;
  return null;
}

export function readingFullSetRunnerModuleKey(
  attempt: ReadingFullSetAttemptSummary
) {
  return readingFullSetActiveModuleAttempt(attempt)?.moduleAttemptId ?? null;
}

export function readingFullSetPrepAction(attempt: ReadingFullSetAttemptSummary | null) {
  if (!attempt) return { label: "开始 Module 1", action: "start_module_1" as const };
  switch (readingFullSetAttemptPhase(attempt)) {
    case "module_1_active":
      return { label: "继续 Module 1", action: "continue_module_1" as const };
    case "module_2_ready":
      return { label: "开始 Module 2", action: "start_module_2" as const };
    case "module_2_active":
      return { label: "继续 Module 2", action: "continue_module_2" as const };
    case "completed":
      return { label: "练习已完成", action: "completed" as const };
  }
}

export function readingFullSetRemainingSeconds(input: {
  deadlineAt: string;
  serverNow: string;
  clientNowAtSyncMs?: number;
  clientNowMs?: number;
}) {
  const serverNowMs = Date.parse(input.serverNow);
  const deadlineMs = Date.parse(input.deadlineAt);
  const clientNowMs = input.clientNowMs ?? Date.now();
  const clientNowAtSyncMs = input.clientNowAtSyncMs ?? clientNowMs;
  if (!Number.isFinite(serverNowMs) || !Number.isFinite(deadlineMs)) return 0;
  const synchronizedDeadlineMs = clientNowAtSyncMs + (deadlineMs - serverNowMs);
  return Math.max(0, Math.ceil((synchronizedDeadlineMs - clientNowMs) / 1000));
}

export function readingFullSetOccurrenceWorkspaceCount(
  occurrence: ReadingFullSetRunnerOccurrence
) {
  return occurrence.taskType === "ctw"
    ? 1
    : occurrence.sourceQuestionEnd - occurrence.sourceQuestionStart + 1;
}

export function readingFullSetDisplayRange(
  occurrence: ReadingFullSetRunnerOccurrence,
  questionIndex: number
) {
  if (occurrence.taskType === "ctw") {
    return {
      start: occurrence.sourceQuestionStart,
      end: occurrence.sourceQuestionEnd
    };
  }
  const displayNumber = occurrence.sourceQuestionStart + questionIndex;
  return { start: displayNumber, end: displayNumber };
}

export function moveReadingFullSetPosition(
  occurrences: ReadingFullSetRunnerOccurrence[],
  position: ReadingFullSetRunnerPosition,
  direction: -1 | 1
): ReadingFullSetRunnerPosition {
  const occurrence = occurrences[position.occurrenceIndex];
  if (!occurrence) return { occurrenceIndex: 0, questionIndex: 0 };
  const workspaceCount = readingFullSetOccurrenceWorkspaceCount(occurrence);
  if (direction === 1 && position.questionIndex + 1 < workspaceCount) {
    return { ...position, questionIndex: position.questionIndex + 1 };
  }
  if (direction === -1 && position.questionIndex > 0) {
    return { ...position, questionIndex: position.questionIndex - 1 };
  }
  const occurrenceIndex = position.occurrenceIndex + direction;
  if (occurrenceIndex < 0 || occurrenceIndex >= occurrences.length) return position;
  return {
    occurrenceIndex,
    questionIndex: direction === 1
      ? 0
      : readingFullSetOccurrenceWorkspaceCount(occurrences[occurrenceIndex]) - 1
  };
}

export function isReadingFullSetAttemptSummary(
  value: unknown
): value is ReadingFullSetAttemptSummary {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Partial<ReadingFullSetAttemptSummary>;
  return typeof attempt.attemptId === "string"
    && typeof attempt.fullSetId === "string"
    && (attempt.status === "in_progress" || attempt.status === "completed")
    && (attempt.currentModule === 1 || attempt.currentModule === 2)
    && typeof attempt.startedAt === "string"
    && typeof attempt.serverNow === "string"
    && isReadingFullSetModuleAttemptSummary(attempt.module1)
    && (attempt.module2 === null || isReadingFullSetModuleAttemptSummary(attempt.module2));
}

function isReadingFullSetModuleAttemptSummary(
  value: unknown
): value is ReadingFullSetModuleAttemptSummary {
  if (!value || typeof value !== "object") return false;
  const moduleAttempt = value as Partial<ReadingFullSetModuleAttemptSummary>;
  return typeof moduleAttempt.moduleAttemptId === "string"
    && (moduleAttempt.moduleNumber === 1 || moduleAttempt.moduleNumber === 2)
    && (moduleAttempt.status === "active" || moduleAttempt.status === "submitted")
    && Number.isInteger(moduleAttempt.timeLimitSeconds)
    && typeof moduleAttempt.startedAt === "string"
    && typeof moduleAttempt.deadlineAt === "string"
    && Number.isInteger(moduleAttempt.answerRevision);
}
