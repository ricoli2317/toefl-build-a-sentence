import { wrongAnswerDedupeKey } from "./practiceHistory.ts";
import type { ReadingModule } from "./reading/types.ts";

/** Canonical wrong-question task types for the student wrongbook. */
export const WRONG_QUESTION_BANK_TASK_TYPES = ["bas", "ctw", "rdl", "rap"] as const;

export type WrongQuestionBankTaskType = (typeof WRONG_QUESTION_BANK_TASK_TYPES)[number];

export const WRONG_QUESTION_BANK_LABELS: Record<WrongQuestionBankTaskType, string> = {
  bas: "Build a Sentence",
  ctw: "Complete the Words",
  rdl: "Read in Daily Life",
  rap: "Read an Academic Passage"
};

export type WrongQuestionPendingCounts = Record<WrongQuestionBankTaskType, number>;

export const WRONG_QUESTION_HISTORY_AMOUNTS = [5, 10, 15, 20] as const;

export type WrongQuestionHistoryAmount = (typeof WRONG_QUESTION_HISTORY_AMOUNTS)[number];

/** Slot sentinel used by Reading question identities without a CTW slot. */
export const WRONG_QUESTION_QUESTION_SLOT = "question";

export type WrongQuestionBankEvent = {
  event: "wrong" | "corrected";
  taskType: WrongQuestionBankTaskType;
  questionKey: string;
  questionId: string;
  logicalItemId: string | null;
  slotId: string | null;
};

export type WrongQuestionBankRow = {
  firstWrongAt: string;
  logicalItemId: string | null;
  /** Business date the row is pending for; null = not pending. */
  pendingDate: string | null;
  questionId: string;
  questionKey: string;
  slotId: string | null;
};

export type WrongQuestionSessionTarget = {
  questionId: string;
  slotId: string | null;
};

export type WrongQuestionSessionGroup = {
  logicalItemId: string;
  targets: WrongQuestionSessionTarget[];
  title: string;
};

export type WrongQuestionSessionProgress = {
  attemptId: string;
  correctPoints: number;
  submittedAt: string;
  totalPoints: number;
};

export type WrongQuestionPracticeSession = {
  /** BAS manifest. */
  questionIds?: string[];
  amount: number | null;
  createdAt: string;
  /**
   * Reading sessions: the whole-session elapsed time, computed server-side and
   * returned together with the manifest. Reading it with the first screen keeps
   * the review's status bar stable instead of recomputing as sources load.
   */
  elapsedSeconds?: number | null;
  /** Reading manifest; the order is frozen when the session is created. */
  groups?: WrongQuestionSessionGroup[];
  mode: "history" | "today";
  progress: Record<string, WrongQuestionSessionProgress>;
  sessionId: string;
  status: "active" | "completed";
  taskType: WrongQuestionBankTaskType;
};

export type WrongQuestionSessionManifest =
  | { kind: "bas"; questionIds: string[] }
  | { kind: "reading"; groups: WrongQuestionSessionGroup[] };

export type WrongQuestionAmountOption = {
  amount: WrongQuestionHistoryAmount;
  enabled: boolean;
  /** Only the single enabled amount above the history count carries a hint. */
  shortfallHint: string | null;
};

/**
 * Dedupe identity for the wrong-question bank.
 *   BAS              -> the existing BAS wrongbook content key
 *                       (`sentence:<normalized final sentence>` when present,
 *                       else `question:<id>`) so different question_ids of the
 *                       same logical BAS question share one identity.
 *   CTW / RDL / RAP  -> logical_item_id:question_id:(slot_id | 'question')
 * Full Set wrong answers reuse the Reading identity (the occurrence is not part
 * of the canonical logical question).
 */
export function wrongQuestionBankKey(input: {
  finalSentence?: string | null;
  logicalItemId?: string | null;
  questionId: string;
  slotId?: string | null;
  taskType: WrongQuestionBankTaskType;
}) {
  if (input.taskType === "bas") {
    // Same rule the historical BAS wrongbook already used.
    return wrongAnswerDedupeKey({
      finalSentence: input.finalSentence ?? "",
      questionId: input.questionId
    });
  }
  return [
    input.logicalItemId ?? "",
    input.questionId,
    input.slotId ?? WRONG_QUESTION_QUESTION_SLOT
  ].join(":");
}

export function wrongQuestionBankEvent(input: {
  event: "corrected" | "wrong";
  finalSentence?: string | null;
  logicalItemId?: string | null;
  questionId: string;
  slotId?: string | null;
  taskType: WrongQuestionBankTaskType;
}): WrongQuestionBankEvent {
  return {
    event: input.event,
    taskType: input.taskType,
    questionKey: wrongQuestionBankKey(input),
    questionId: input.questionId,
    logicalItemId: input.logicalItemId ?? null,
    slotId: input.slotId ?? null
  };
}

/**
 * 5 / 10 / 15 / 20 enablement:
 *   * every amount <= history count is enabled
 *   * plus the smallest amount above the history count (practice uses min(amount, count))
 *   * X = 0 disables everything
 */
export function wrongQuestionAmountOptions(historyCount: number): WrongQuestionAmountOption[] {
  const count = Math.max(0, Math.floor(historyCount));
  const nextAbove = count > 0
    ? WRONG_QUESTION_HISTORY_AMOUNTS.find((amount) => amount > count) ?? null
    : null;
  return WRONG_QUESTION_HISTORY_AMOUNTS.map((amount) => ({
    amount,
    enabled: amount <= count || amount === nextAbove,
    shortfallHint: amount === nextAbove && amount > count
      ? `当前历史错题共 ${count} 道`
      : null
  }));
}

/** Actual practice size for a chosen amount; never padded. */
export function wrongQuestionPracticeCount(amount: number, historyCount: number) {
  return Math.max(0, Math.min(Math.floor(amount), Math.floor(historyCount)));
}

/**
 * The stored session amount is the effective practice size (`min(asked, pool)`),
 * which can be any number up to 20. Chooser entry points only accept
 * 5 / 10 / 15 / 20, so a retake asks for the smallest valid amount that still
 * covers the stored size (the server draws `min(amount, pool)` again, so the
 * new session is never larger than the pool).
 */
export function nextWrongQuestionHistoryAmount(storedAmount: number) {
  const size = Math.max(0, Math.floor(storedAmount));
  return WRONG_QUESTION_HISTORY_AMOUNTS.find((amount) => amount >= size)
    ?? WRONG_QUESTION_HISTORY_AMOUNTS[WRONG_QUESTION_HISTORY_AMOUNTS.length - 1];
}

export function isWrongQuestionBankTaskType(value: unknown): value is WrongQuestionBankTaskType {
  return typeof value === "string"
    && (WRONG_QUESTION_BANK_TASK_TYPES as readonly string[]).includes(value);
}

export function isWrongQuestionHistoryAmount(value: unknown): value is WrongQuestionHistoryAmount {
  return typeof value === "number"
    && (WRONG_QUESTION_HISTORY_AMOUNTS as readonly number[]).includes(value);
}

/**
 * One parser for every history-amount entry point (API + pages). Anything other
 * than exactly 5 / 10 / 15 / 20 is rejected, so the removed "practice all
 * history questions" capability has no remaining execution path.
 */
export function normalizeWrongQuestionHistoryAmount(value: unknown): WrongQuestionHistoryAmount | null {
  const numeric = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return isWrongQuestionHistoryAmount(numeric) ? numeric : null;
}

/**
 * Formal BAS practice produces pending wrong questions. Only ordinary practice
 * sets qualify; wrongbook / grammar overviews are virtual. `wrongbook-today-*`
 * submissions are today's corrections and only clear pending state.
 *
 * The answer's final sentence participates so the identity stays the existing
 * content-level BAS dedupe key, never a bare question_id.
 */
export function basWrongQuestionEvents(input: {
  answers: Array<{ finalSentence?: string | null; isCorrect: boolean; questionId: string }>;
  official: boolean;
  setId: string;
}): WrongQuestionBankEvent[] {
  const setId = input.setId.trim().toLocaleLowerCase();
  if (setId.startsWith("wrongbook-today-")) {
    return input.answers
      .filter((answer) => answer.isCorrect)
      .map((answer) => wrongQuestionBankEvent({
        event: "corrected",
        finalSentence: answer.finalSentence,
        questionId: answer.questionId,
        taskType: "bas"
      }));
  }
  if (!input.official || setId.startsWith("wrongbook-") || setId.startsWith("grammar-")) {
    return [];
  }
  return input.answers
    .filter((answer) => !answer.isCorrect)
    .map((answer) => wrongQuestionBankEvent({
      event: "wrong",
      finalSentence: answer.finalSentence,
      questionId: answer.questionId,
      taskType: "bas"
    }));
}

/** Ordinary Reading practice (including Full Set-sourced answers) creates pending state. */
export function readingWrongAnswerEvents(input: {
  answers: Array<{ isCorrect: boolean; questionId: string; slotId: string | null }>;
  logicalItemId: string;
  taskType: ReadingModule;
}): WrongQuestionBankEvent[] {
  return input.answers
    .filter((answer) => !answer.isCorrect)
    .map((answer) => wrongQuestionBankEvent({
      event: "wrong",
      logicalItemId: input.logicalItemId,
      questionId: answer.questionId,
      slotId: answer.slotId,
      taskType: input.taskType
    }));
}

/**
 * Correction submissions clear pending state only when they belong to the
 * clearing flows (`today` practice / formal-result entry corrections). History
 * practice corrections never change pending or history membership.
 */
export function readingCorrectionEvents(input: {
  answers: Array<{ isCorrect: boolean; questionId: string; slotId: string | null }>;
  appliesToPending: boolean;
  logicalItemId: string;
  taskType: ReadingModule;
}): WrongQuestionBankEvent[] {
  if (!input.appliesToPending) return [];
  return input.answers
    .filter((answer) => answer.isCorrect)
    .map((answer) => wrongQuestionBankEvent({
      event: "corrected",
      logicalItemId: input.logicalItemId,
      questionId: answer.questionId,
      slotId: answer.slotId,
      taskType: input.taskType
    }));
}

/**
 * Reading session grouping: the draw order of logical items is preserved and
 * each item keeps its canonical question order; a group is one screen.
 */
export function buildReadingSessionGroups(input: {
  questionOrderById: Map<string, number>;
  targets: Array<{ logicalItemId: string | null; questionId: string; slotId: string | null }>;
  titles: Map<string, string>;
}): WrongQuestionSessionGroup[] {
  const groups = new Map<string, WrongQuestionSessionGroup>();
  for (const target of input.targets) {
    const logicalItemId = target.logicalItemId ?? "";
    const existing = groups.get(logicalItemId);
    const entry = { questionId: target.questionId, slotId: target.slotId };
    if (existing) {
      existing.targets.push(entry);
      continue;
    }
    groups.set(logicalItemId, {
      logicalItemId,
      targets: [entry],
      title: input.titles.get(logicalItemId)?.trim() || logicalItemId
    });
  }
  return Array.from(groups.values()).map((group) => ({
    ...group,
    targets: [...group.targets].sort((left, right) =>
      (input.questionOrderById.get(left.questionId) ?? Number.MAX_SAFE_INTEGER)
        - (input.questionOrderById.get(right.questionId) ?? Number.MAX_SAFE_INTEGER)
      || left.questionId.localeCompare(right.questionId)
      || (left.slotId ?? "").localeCompare(right.slotId ?? "")
    )
  }));
}

export function shuffleWrongQuestionTargets<T>(items: T[]) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}
