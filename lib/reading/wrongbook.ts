import type { ReadingAttemptSummary, ReadingSubmittedAnswer } from "./attempts";
import type { ReadingAnswerState } from "./practiceState";
import type { StudentReadingPracticePayload } from "./studentPractice";
import type { ReadingModule } from "./types";
import type { ReadingWrongbookQueueItem, ReadingWrongbookTarget } from "../wrongQuestions";
import type {
  ReadingFullSetWrongbookQueueItem,
  ReadingFullSetWrongbookTarget
} from "../wrongQuestions";

export type ReadingWrongbookScope = "history" | "today";

export type ReadingWrongbookAttemptSummary = ReadingAttemptSummary & {
  scope: ReadingWrongbookScope;
  targets: ReadingWrongbookTarget[];
};

export type ReadingWrongbookQueuePayload = {
  items: ReadingWrongbookQueueItem[];
  scope: ReadingWrongbookScope;
  taskType: ReadingModule;
};

export type ReadingWrongbookPreservedAnswer = {
  answerKind: ReadingSubmittedAnswer["kind"];
  isCorrect: true;
  questionId: string;
  slotId: string | null;
  studentAnswer: string;
};

export type ReadingFullSetWrongbookAttemptSummary = {
  attemptId: string;
  correctPoints: number;
  elapsedSeconds: number;
  incorrectPoints: number;
  scope: ReadingWrongbookScope;
  sourceAttemptId: string;
  sourceFullSetId: string;
  startedAt: string;
  status: "draft" | "submitted";
  submittedAt: string | null;
  targets: ReadingFullSetWrongbookTarget[];
  taskType: "full_set";
  totalPoints: number;
  unansweredPoints: number;
  created?: boolean;
  resumed?: boolean;
  alreadySubmitted?: boolean;
};

export type ReadingFullSetWrongbookQueuePayload = {
  items: ReadingFullSetWrongbookQueueItem[];
  scope: ReadingWrongbookScope;
  taskType: "full_set";
};

export function isReadingWrongbookScope(value: unknown): value is ReadingWrongbookScope {
  return value === "history" || value === "today";
}

export function isReadingWrongbookAttemptSummary(
  value: unknown
): value is ReadingWrongbookAttemptSummary {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Partial<ReadingWrongbookAttemptSummary>;
  return typeof attempt.attemptId === "string"
    && typeof attempt.logicalItemId === "string"
    && (attempt.taskType === "ctw" || attempt.taskType === "rdl" || attempt.taskType === "rap")
    && (attempt.scope === "history" || attempt.scope === "today")
    && (attempt.status === "draft" || attempt.status === "submitted")
    && Number.isInteger(attempt.elapsedSeconds)
    && typeof attempt.startedAt === "string"
    && Number.isInteger(attempt.totalPoints)
    && Number.isInteger(attempt.correctPoints)
    && Number.isInteger(attempt.incorrectPoints)
    && Number.isInteger(attempt.unansweredPoints)
    && Array.isArray(attempt.targets)
    && attempt.targets.length > 0
    && attempt.targets.every(isReadingWrongbookTarget);
}

export function isReadingWrongbookQueuePayload(
  value: unknown
): value is ReadingWrongbookQueuePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ReadingWrongbookQueuePayload>;
  return isReadingWrongbookScope(payload.scope)
    && (payload.taskType === "ctw" || payload.taskType === "rdl" || payload.taskType === "rap")
    && Array.isArray(payload.items)
    && payload.items.every((item) => Boolean(
      item
      && typeof item.logicalItemId === "string"
      && item.taskType === payload.taskType
      && typeof item.title === "string"
      && Array.isArray(item.targets)
      && item.targets.length > 0
      && item.targets.every(isReadingWrongbookTarget)
    ));
}

export function isReadingFullSetWrongbookAttemptSummary(
  value: unknown
): value is ReadingFullSetWrongbookAttemptSummary {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Partial<ReadingFullSetWrongbookAttemptSummary>;
  return typeof attempt.attemptId === "string"
    && attempt.taskType === "full_set"
    && (attempt.scope === "history" || attempt.scope === "today")
    && typeof attempt.sourceAttemptId === "string"
    && typeof attempt.sourceFullSetId === "string"
    && (attempt.status === "draft" || attempt.status === "submitted")
    && Number.isInteger(attempt.elapsedSeconds)
    && typeof attempt.startedAt === "string"
    && Number.isInteger(attempt.totalPoints)
    && Number.isInteger(attempt.correctPoints)
    && Number.isInteger(attempt.incorrectPoints)
    && Number.isInteger(attempt.unansweredPoints)
    && Array.isArray(attempt.targets)
    && attempt.targets.length > 0
    && attempt.targets.every(isReadingFullSetWrongbookTarget);
}

export function isReadingFullSetWrongbookQueuePayload(
  value: unknown
): value is ReadingFullSetWrongbookQueuePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<ReadingFullSetWrongbookQueuePayload>;
  return isReadingWrongbookScope(payload.scope)
    && payload.taskType === "full_set"
    && Array.isArray(payload.items)
    && payload.items.every((item) => Boolean(
      item
      && typeof item.fullSetId === "string"
      && typeof item.sourceAttemptId === "string"
      && typeof item.title === "string"
      && Array.isArray(item.targets)
      && item.targets.length > 0
      && item.targets.every(isReadingFullSetWrongbookTarget)
    ));
}

export function selectReadingWrongbookPractice(
  practice: StudentReadingPracticePayload,
  targets: ReadingWrongbookTarget[]
): StudentReadingPracticePayload {
  const targetQuestionIds = new Set(targets.map((target) => target.questionId));
  const questions = practice.item.module === "ctw"
    ? practice.questions
    : practice.questions.filter((question) => targetQuestionIds.has(question.questionId));
  return {
    ...practice,
    item: {
      ...practice.item,
      questionCount: practice.item.module === "ctw" ? practice.item.questionCount : questions.length,
      scoringPointCount: targets.length
    },
    questions
  };
}

export function selectReadingWrongbookSubmissionAnswers(
  answers: ReadingSubmittedAnswer[],
  targets: ReadingWrongbookTarget[]
) {
  const targetKeys = new Set(targets.map(readingWrongbookTargetKey));
  return answers.filter((answer) => targetKeys.has(readingWrongbookTargetKey({
    questionId: answer.questionId,
    slotId: answer.slotId ?? null
  })));
}

export function readingWrongbookEditableSlotIds(targets: ReadingWrongbookTarget[]) {
  return new Set(targets.flatMap((target) => target.slotId ? [target.slotId] : []));
}

export function buildReadingWrongbookInitialAnswers(
  practice: StudentReadingPracticePayload,
  preservedAnswers: ReadingWrongbookPreservedAnswer[]
): ReadingAnswerState {
  const ctwRows = new Map(preservedAnswers
    .filter((answer) => answer.answerKind === "ctw_slot" && answer.slotId)
    .map((answer) => [`${answer.questionId}:${answer.slotId}`, answer.studentAnswer]));
  const answers: ReadingAnswerState = {};
  for (const question of practice.questions) {
    if (question.questionType !== "ctw") continue;
    answers[question.questionId] = {
      kind: "ctw",
      slots: Object.fromEntries(question.slots.map((slot) => {
        const value = Array.from(ctwRows.get(`${question.questionId}:${slot.slotId}`) ?? "")
          .slice(0, slot.missingLength);
        return [slot.slotId, [
          ...value,
          ...Array.from({ length: Math.max(0, slot.missingLength - value.length) }, () => "")
        ]];
      }))
    };
  }
  return answers;
}

export function readingWrongbookTargetKey(target: ReadingWrongbookTarget) {
  return `${target.questionId}:${target.slotId ?? "question"}`;
}

function isReadingWrongbookTarget(value: unknown): value is ReadingWrongbookTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<ReadingWrongbookTarget>;
  return typeof target.questionId === "string"
    && (target.sourceAttemptId === undefined || typeof target.sourceAttemptId === "string")
    && (target.slotId === null || typeof target.slotId === "string");
}

function isReadingFullSetWrongbookTarget(value: unknown): value is ReadingFullSetWrongbookTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<ReadingFullSetWrongbookTarget>;
  return typeof target.logicalItemId === "string"
    && (target.moduleNumber === 1 || target.moduleNumber === 2)
    && typeof target.occurrenceId === "string"
    && Number.isInteger(target.order)
    && typeof target.questionId === "string"
    && (target.slotId === null || typeof target.slotId === "string")
    && (target.taskType === "ctw" || target.taskType === "rdl" || target.taskType === "rap");
}
