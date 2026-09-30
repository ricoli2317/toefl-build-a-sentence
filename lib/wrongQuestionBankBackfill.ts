import {
  wrongQuestionBankKey,
  type WrongQuestionBankTaskType
} from "./wrongQuestionBank.ts";

/**
 * Pure rule mirror of `supabase/student_wrong_questions_backfill.sql`.
 *
 * The SQL backfill and this module must stay in sync; the fixture tests in
 * tests/wrongQuestionBankBackfill.test.js pin the rules that the SQL applies:
 *   * history only comes from formal practice wrongs (corrections never create
 *     or extend an identity);
 *   * daily pending is "current state for one business date": the latest
 *     state-setting event per canonical key wins (formal wrong -> pending for
 *     that wrong's date, clearing correction correct -> cleared), and only keys
 *     whose winning wrong happened on the target date are restored;
 *   * non-clearing corrections (history practice / history-flow entry) never
 *     change pending or history;
 *   * BAS identity is the existing content key (sentence when present), never a
 *     bare question_id.
 */

export type WrongQuestionBackfillAnswerKind =
  /** Ordinary practice / Full Set submission. */
  | "formal"
  /** Today practice and formal-result entry corrections (clear on correct). */
  | "clearing-correction"
  /** History practice and history-result entry corrections (never affect state). */
  | "non-clearing-correction";

export type WrongQuestionBackfillAnswer = {
  /** Business date (YYYY-MM-DD) of the event, from the shared server rule. */
  eventDate: string;
  eventTimeMs: number;
  finalSentence?: string | null;
  isCorrect: boolean;
  kind: WrongQuestionBackfillAnswerKind;
  logicalItemId?: string | null;
  questionId: string;
  slotId?: string | null;
  studentId: string;
  taskType: WrongQuestionBankTaskType;
};

export type WrongQuestionBackfillIdentity = {
  firstWrongAtMs: number;
  key: string;
  lastWrongAtMs: number;
  studentId: string;
  taskType: WrongQuestionBankTaskType;
};

export type WrongQuestionBackfillPendingEntry = {
  key: string;
  pendingDate: string;
  studentId: string;
  taskType: WrongQuestionBankTaskType;
};

function answerKey(answer: WrongQuestionBackfillAnswer) {
  return wrongQuestionBankKey({
    finalSentence: answer.finalSentence,
    logicalItemId: answer.logicalItemId,
    questionId: answer.questionId,
    slotId: answer.slotId,
    taskType: answer.taskType
  });
}

function scopedKey(answer: WrongQuestionBackfillAnswer) {
  return `${answer.studentId}|${answer.taskType}|${answerKey(answer)}`;
}

/** Formal practice wrongs only; repeated wrongs collapse into one identity. */
export function buildWrongQuestionBackfillHistory(
  answers: WrongQuestionBackfillAnswer[]
): WrongQuestionBackfillIdentity[] {
  const identities = new Map<string, WrongQuestionBackfillIdentity>();
  for (const answer of answers) {
    if (answer.kind !== "formal" || answer.isCorrect) continue;
    const mapKey = scopedKey(answer);
    const existing = identities.get(mapKey);
    if (!existing) {
      identities.set(mapKey, {
        firstWrongAtMs: answer.eventTimeMs,
        key: answerKey(answer),
        lastWrongAtMs: answer.eventTimeMs,
        studentId: answer.studentId,
        taskType: answer.taskType
      });
      continue;
    }
    existing.firstWrongAtMs = Math.min(existing.firstWrongAtMs, answer.eventTimeMs);
    existing.lastWrongAtMs = Math.max(existing.lastWrongAtMs, answer.eventTimeMs);
  }
  return Array.from(identities.values());
}

/**
 * Restores only the target business date's pending state:
 *   formal wrong      -> pending for the wrong's own date
 *   clearing correct  -> cleared
 * Older uncorrected wrongs stay history-only; they are never re-dated into the
 * target day, and a wrong on the target day re-dates an older pending row.
 */
export function buildWrongQuestionBackfillPending(input: {
  answers: WrongQuestionBackfillAnswer[];
  practiceDate: string;
}): WrongQuestionBackfillPendingEntry[] {
  const latest = new Map<string, {
    eventTimeMs: number;
    entry: WrongQuestionBackfillPendingEntry | null;
  }>();

  for (const answer of input.answers) {
    const mapKey = scopedKey(answer);
    // Live state-setting events only: formal wrongs and clearing corrects.
    const pendingEvent = answer.kind === "formal"
      ? answer.isCorrect
        ? null
        : true
      : answer.kind === "clearing-correction"
        ? answer.isCorrect
          ? false
          : null
        : null;
    if (pendingEvent === null) continue;
    const existing = latest.get(mapKey);
    // Latest wins; on an exact tie the clearing event wins.
    if (
      !existing
      || answer.eventTimeMs > existing.eventTimeMs
      || (answer.eventTimeMs === existing.eventTimeMs && !pendingEvent)
    ) {
      latest.set(mapKey, {
        entry: pendingEvent
          ? {
              key: answerKey(answer),
              pendingDate: answer.eventDate,
              studentId: answer.studentId,
              taskType: answer.taskType
            }
          : null,
        eventTimeMs: answer.eventTimeMs
      });
    }
  }

  return Array.from(latest.values())
    .map((state) => state.entry)
    .filter((entry): entry is WrongQuestionBackfillPendingEntry => Boolean(entry))
    .filter((entry) => entry.pendingDate === input.practiceDate);
}
