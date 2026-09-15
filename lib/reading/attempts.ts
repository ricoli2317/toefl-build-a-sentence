import type { StudentReadingPracticePayload } from "./studentPractice.ts";
import type { ReadingAnswerState } from "./practiceState.ts";

export type ReadingAttemptStatus = "draft" | "submitted";

export type ReadingAttemptSummary = {
  attemptId: string;
  logicalItemId: string;
  taskType: StudentReadingPracticePayload["item"]["module"];
  status: ReadingAttemptStatus;
  elapsedSeconds: number;
  startedAt: string;
  submittedAt: string | null;
  totalPoints: number;
  correctPoints: number;
  incorrectPoints: number;
  unansweredPoints: number;
  created?: boolean;
  resumed?: boolean;
  alreadySubmitted?: boolean;
};

export type ReadingSubmittedAnswer = {
  kind: "ctw_slot" | "option" | "insertion_anchor" | "sentence_selection";
  questionId: string;
  questionTimeSeconds: number;
  slotId?: string;
  studentAnswer: string | null;
};

export function buildReadingSubmissionAnswers(
  practice: StudentReadingPracticePayload,
  answers: ReadingAnswerState,
  questionTimes: Record<string, number>
): ReadingSubmittedAnswer[] {
  const submitted: ReadingSubmittedAnswer[] = [];
  for (const question of practice.questions) {
    const answer = answers[question.questionId];
    if (question.questionType === "ctw") {
      const slots = answer?.kind === "ctw" ? answer.slots : {};
      submitted.push(...question.slots.map((slot): ReadingSubmittedAnswer => ({
          kind: "ctw_slot",
          questionId: question.questionId,
          questionTimeSeconds: normalizeQuestionTime(questionTimes[question.questionId]),
          slotId: slot.slotId,
          studentAnswer: normalizeStudentAnswer((slots[slot.slotId] ?? []).join(""))
        })));
      continue;
    }
    if (question.questionType === "rap_sentence_insertion") {
      submitted.push({
        kind: "insertion_anchor",
        questionId: question.questionId,
        questionTimeSeconds: normalizeQuestionTime(questionTimes[question.questionId]),
        studentAnswer: answer?.kind === "insertion" ? answer.anchorId : null
      });
      continue;
    }
    if (question.questionType === "rap_sentence_selection") {
      submitted.push({
        kind: "sentence_selection",
        questionId: question.questionId,
        questionTimeSeconds: normalizeQuestionTime(questionTimes[question.questionId]),
        studentAnswer: answer?.kind === "sentence_selection" ? answer.sentenceId : null
      });
      continue;
    }
    submitted.push({
      kind: "option",
      questionId: question.questionId,
      questionTimeSeconds: normalizeQuestionTime(questionTimes[question.questionId]),
      studentAnswer: answer?.kind === "choice" ? answer.optionId : null
    });
  }
  return submitted;
}

export function buildReadingAnswerStateFromSubmission(
  practice: StudentReadingPracticePayload,
  submitted: ReadingSubmittedAnswer[]
): ReadingAnswerState {
  const byQuestion = new Map<string, ReadingSubmittedAnswer[]>();
  for (const answer of submitted) {
    const values = byQuestion.get(answer.questionId) ?? [];
    values.push(answer);
    byQuestion.set(answer.questionId, values);
  }
  const state: ReadingAnswerState = {};
  for (const question of practice.questions) {
    const answers = byQuestion.get(question.questionId) ?? [];
    if (question.questionType === "ctw") {
      state[question.questionId] = {
        kind: "ctw",
        slots: Object.fromEntries(question.slots.map((slot) => {
          const value = answers.find((answer) => answer.slotId === slot.slotId)?.studentAnswer ?? "";
          return [slot.slotId, Array.from({ length: slot.missingLength }, (_, index) => value[index] ?? "")];
        }))
      };
    } else if (question.questionType === "rap_sentence_insertion") {
      state[question.questionId] = {
        anchorId: answers[0]?.studentAnswer ?? null,
        kind: "insertion"
      };
    } else if (question.questionType === "rap_sentence_selection") {
      state[question.questionId] = {
        kind: "sentence_selection",
        sentenceId: answers[0]?.studentAnswer ?? null
      };
    } else {
      state[question.questionId] = {
        kind: "choice",
        optionId: answers[0]?.studentAnswer ?? null
      };
    }
  }
  return state;
}

function normalizeQuestionTime(value: number | undefined) {
  return Number.isFinite(value) && value !== undefined && value >= 0
    ? Math.min(604800, Math.round(value))
    : 0;
}

function normalizeStudentAnswer(value: string | null | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

export function isReadingAttemptSummary(value: unknown): value is ReadingAttemptSummary {
  if (!value || typeof value !== "object") return false;
  const attempt = value as Partial<ReadingAttemptSummary>;
  return typeof attempt.attemptId === "string"
    && typeof attempt.logicalItemId === "string"
    && ["ctw", "rdl", "rap"].includes(attempt.taskType ?? "")
    && ["draft", "submitted"].includes(attempt.status ?? "")
    && Number.isInteger(attempt.elapsedSeconds)
    && typeof attempt.startedAt === "string"
    && Number.isInteger(attempt.totalPoints)
    && Number.isInteger(attempt.correctPoints)
    && Number.isInteger(attempt.incorrectPoints)
    && Number.isInteger(attempt.unansweredPoints);
}
