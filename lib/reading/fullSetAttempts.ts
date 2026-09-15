import type { ReadingAnswerState } from "./practiceState.ts";
import type { ReadingModule } from "./types.ts";

export type ReadingFullSetAttemptStatus = "in_progress" | "completed";
export type ReadingFullSetModuleStatus = "preparing" | "active" | "paused" | "submitted";
export type ReadingFullSetSubmissionReason = "manual" | "timeout" | null;

export type ReadingFullSetModuleAttemptSummary = {
  moduleAttemptId: string;
  moduleNumber: 1 | 2;
  status: ReadingFullSetModuleStatus;
  timeLimitSeconds: number;
  startedAt: string | null;
  deadlineAt: string | null;
  remainingSeconds: number;
  timerRevision: number;
  submittedAt: string | null;
  submissionReason: ReadingFullSetSubmissionReason;
  answerRevision: number;
  currentOccurrenceId: string | null;
  currentQuestionIndex: number | null;
  cursorRevision: number;
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
  | "module_1_preparing"
  | "module_1_active"
  | "module_2_ready"
  | "module_2_preparing"
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

export type ReadingFullSetBootstrapPayload = {
  firstOccurrence: ReadingFullSetOccurrencePracticePayload;
  reviewCompletedQuestionNumbers?: number[];
  runner: ReadingFullSetRunnerPayload;
  traceId: string;
};

export function isReadingFullSetBootstrapPayload(
  value: unknown
): value is ReadingFullSetBootstrapPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ReadingFullSetBootstrapPayload>;
  if (
    !payload.runner
    || !isReadingFullSetAttemptSummary(payload.runner.attempt)
    || !Array.isArray(payload.runner.occurrences)
    || typeof payload.runner.title !== "string"
    || !payload.firstOccurrence
    || typeof payload.traceId !== "string"
  ) return false;
  const first = payload.firstOccurrence as Partial<ReadingFullSetOccurrencePracticePayload>;
  return Boolean(first.occurrence)
    && typeof first.answerRevision === "number"
    && Boolean(first.answers && typeof first.answers === "object")
    && Boolean(first.practice && typeof first.practice === "object")
    && Boolean(first.questionTimes && typeof first.questionTimes === "object")
    && (payload.reviewCompletedQuestionNumbers === undefined
      || (Array.isArray(payload.reviewCompletedQuestionNumbers)
        && payload.reviewCompletedQuestionNumbers.every((questionNumber) =>
          Number.isInteger(questionNumber) && questionNumber > 0
        )))
    && payload.runner.occurrences.some(
      (occurrence) => occurrence.occurrenceId === first.occurrence?.occurrenceId
    );
}

export type ReadingFullSetRunnerPosition = {
  occurrenceIndex: number;
  questionIndex: number;
};

export function readingFullSetAttemptPhase(
  attempt: ReadingFullSetAttemptSummary
): ReadingFullSetAttemptPhase {
  if (attempt.status === "completed") return "completed";
  if (attempt.module2?.status === "preparing") return "module_2_preparing";
  if (attempt.module2?.status === "active" || attempt.module2?.status === "paused") return "module_2_active";
  if (attempt.module1.status === "submitted") return "module_2_ready";
  return attempt.module1.status === "preparing" ? "module_1_preparing" : "module_1_active";
}

export function readingFullSetActiveModuleAttempt(
  attempt: ReadingFullSetAttemptSummary
): ReadingFullSetModuleAttemptSummary | null {
  const moduleAttempt = readingFullSetCurrentModuleAttempt(attempt);
  return moduleAttempt?.status === "active" ? moduleAttempt : null;
}

export function readingFullSetCurrentModuleAttempt(
  attempt: ReadingFullSetAttemptSummary
): ReadingFullSetModuleAttemptSummary | null {
  const phase = readingFullSetAttemptPhase(attempt);
  if (phase === "module_1_preparing" || phase === "module_1_active") return attempt.module1;
  if (phase === "module_2_preparing" || phase === "module_2_active") return attempt.module2;
  return null;
}

export function readingFullSetRunnerModuleKey(
  attempt: ReadingFullSetAttemptSummary
) {
  return readingFullSetCurrentModuleAttempt(attempt)?.moduleAttemptId ?? null;
}

export function readingFullSetPrepAction(attempt: ReadingFullSetAttemptSummary | null) {
  if (!attempt) return { label: "开始 Module 1", action: "start_module_1" as const };
  switch (readingFullSetAttemptPhase(attempt)) {
    case "module_1_preparing":
    case "module_1_active":
      return { label: "继续 Module 1", action: "continue_module_1" as const };
    case "module_2_ready":
      return { label: "开始 Module 2", action: "start_module_2" as const };
    case "module_2_preparing":
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

export function readingFullSetBootstrapOccurrence(
  occurrences: ReadingFullSetRunnerOccurrence[],
  moduleAttempt: ReadingFullSetModuleAttemptSummary
) {
  if ((moduleAttempt.status !== "active" && moduleAttempt.status !== "paused") || !moduleAttempt.currentOccurrenceId) {
    return occurrences[0] ?? null;
  }
  return occurrences.find(
    (occurrence) => occurrence.occurrenceId === moduleAttempt.currentOccurrenceId
  ) ?? occurrences[0] ?? null;
}

export function readingFullSetRestoredPosition(input: {
  moduleAttempt: ReadingFullSetModuleAttemptSummary;
  occurrences: ReadingFullSetRunnerOccurrence[];
  questionCount: number;
  restoredOccurrenceId: string;
}): ReadingFullSetRunnerPosition {
  const occurrenceIndex = input.occurrences.findIndex(
    (occurrence) => occurrence.occurrenceId === input.restoredOccurrenceId
  );
  if (occurrenceIndex < 0) return { occurrenceIndex: 0, questionIndex: 0 };
  const occurrence = input.occurrences[occurrenceIndex];
  const questionIndex = (input.moduleAttempt.status === "active" || input.moduleAttempt.status === "paused")
    && input.moduleAttempt.currentOccurrenceId === input.restoredOccurrenceId
    && Number.isInteger(input.moduleAttempt.currentQuestionIndex)
    && Number(input.moduleAttempt.currentQuestionIndex) >= 0
    && (occurrence.taskType !== "ctw" || Number(input.moduleAttempt.currentQuestionIndex) === 0)
    && Number(input.moduleAttempt.currentQuestionIndex) < input.questionCount
    ? Number(input.moduleAttempt.currentQuestionIndex)
    : 0;
  return { occurrenceIndex, questionIndex };
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
    && (moduleAttempt.status === "preparing" || moduleAttempt.status === "active" || moduleAttempt.status === "paused" || moduleAttempt.status === "submitted")
    && Number.isInteger(moduleAttempt.timeLimitSeconds)
    && (moduleAttempt.startedAt === null || typeof moduleAttempt.startedAt === "string")
    && (moduleAttempt.deadlineAt === null || typeof moduleAttempt.deadlineAt === "string")
    && (moduleAttempt.status !== "preparing" || (moduleAttempt.startedAt === null && moduleAttempt.deadlineAt === null))
    && (moduleAttempt.status !== "active" || (typeof moduleAttempt.startedAt === "string" && typeof moduleAttempt.deadlineAt === "string"))
    && (moduleAttempt.status !== "paused" || (typeof moduleAttempt.startedAt === "string" && moduleAttempt.deadlineAt === null))
    && (moduleAttempt.status !== "submitted" || typeof moduleAttempt.startedAt === "string")
    && Number.isInteger(moduleAttempt.remainingSeconds)
    && Number(moduleAttempt.remainingSeconds) >= 0
    && Number(moduleAttempt.remainingSeconds) <= Number(moduleAttempt.timeLimitSeconds)
    && Number.isInteger(moduleAttempt.timerRevision)
    && Number(moduleAttempt.timerRevision) >= 0
    && Number.isInteger(moduleAttempt.answerRevision)
    && (moduleAttempt.currentOccurrenceId === null || typeof moduleAttempt.currentOccurrenceId === "string")
    && (moduleAttempt.currentQuestionIndex === null || (Number.isInteger(moduleAttempt.currentQuestionIndex) && Number(moduleAttempt.currentQuestionIndex) >= 0))
    && Number.isInteger(moduleAttempt.cursorRevision)
    && Number(moduleAttempt.cursorRevision) >= 0;
}
