import {
  buildPracticeHistoryPayload,
  correctedWrongAnswerKeys,
  wrongAnswerDedupeKey,
  type PracticeHistoryAnswer,
  type PracticeHistoryAttempt
} from "./practiceHistory.ts";
import type { ReadingModule } from "./reading/types.ts";

export const WRONG_QUESTION_TASK_TYPES = [
  "build_sentence",
  "ctw",
  "rdl",
  "rap",
  "full_set"
] as const;

export type WrongQuestionTaskType = (typeof WRONG_QUESTION_TASK_TYPES)[number];

export const WRONG_QUESTION_TASK_LABELS: Record<WrongQuestionTaskType, string> = {
  build_sentence: "Build a Sentence",
  ctw: "Complete the Words",
  rdl: "Read in Daily Life",
  rap: "Read an Academic Passage",
  full_set: "Reading Full Set"
};

export type WrongQuestionOverviewStats = {
  corrected: number;
  pending: number;
  todayNew: number;
  total: number;
};

export type WrongQuestionGroup = {
  actionHref: string;
  correctionHref: string | null;
  correctedCount: number;
  groupId: string;
  latestWrongAt: string;
  pendingCount: number;
  taskLabel: string;
  taskType: WrongQuestionTaskType;
  title: string;
  wrongCount: number;
};

export type WrongQuestionsOverviewPayload = {
  grammarPoints: Array<{ count: number; tag: string }>;
  groups: WrongQuestionGroup[];
  stats: WrongQuestionOverviewStats;
};

export type BasWrongQuestionAttempt = Omit<PracticeHistoryAttempt, "accuracy">;

export type BasWrongQuestionGroup = {
  groupId: string;
  title: string;
};

export type BasWrongbookPracticeAttempt = {
  attemptId: string;
  createdAt: string | null;
  setId: string;
  submittedAt: string | null;
};

export type BasWrongbookPracticeAnswer = {
  attemptId: string;
  isCorrect: boolean;
  questionId: string;
};

type BasWrongQuestionStateInput = {
  basAnswers: PracticeHistoryAnswer[];
  basAttempts: BasWrongQuestionAttempt[];
  basCorrectionAnswers: PracticeHistoryAnswer[];
  basGroupsBySet: Map<string, BasWrongQuestionGroup>;
  todayEnd: number;
  todayStart: number;
};

export type ReadingWrongQuestionAttempt = {
  attemptId: string;
  logicalItemId: string;
  submittedAt: string;
  taskType: ReadingModule;
};

export type ReadingWrongQuestionAnswer = {
  attemptId: string;
  isCorrect: boolean;
  questionId: string;
  slotId: string | null;
};

export type ReadingWrongbookCorrectionAttempt = ReadingWrongQuestionAttempt & {
  scope: "history" | "today";
};

export type ReadingWrongbookTarget = {
  questionId: string;
  sourceAttemptId?: string;
  slotId: string | null;
};

export type ReadingWrongbookQueueItem = {
  latestWrongAt: string;
  latestWrongAttemptId: string;
  logicalItemId: string;
  targets: ReadingWrongbookTarget[];
  taskType: ReadingModule;
  title: string;
};

export type ReadingFullSetWrongQuestionAttempt = {
  attemptId: string;
  completedAt: string;
  fullSetId: string;
  title: string;
};

export type ReadingFullSetWrongQuestionAnswer = {
  attemptId: string;
  isCorrect: boolean;
  logicalItemId: string;
  moduleNumber: 1 | 2;
  occurrenceId: string;
  order: number;
  questionId: string;
  slotId: string | null;
  taskType: ReadingModule;
};

export type ReadingFullSetWrongbookCorrectionAttempt = {
  attemptId: string;
  sourceAttemptId: string;
  submittedAt: string;
};

export type ReadingFullSetWrongbookTarget = Omit<ReadingFullSetWrongQuestionAnswer, "attemptId" | "isCorrect">;

export type ReadingFullSetWrongbookQueueItem = {
  fullSetId: string;
  latestWrongAt: string;
  sourceAttemptId: string;
  targets: ReadingFullSetWrongbookTarget[];
  title: string;
};

export type ReadingFullSetWrongbookScreen = {
  occurrenceId: string;
  questionId: string;
  taskType: ReadingModule;
  wrongQuestionCount: number;
  wrongQuestionEnd: number;
  wrongQuestionStart: number;
};

export type ReadingFullSetWrongbookProgress = {
  screenCount: number;
  screens: ReadingFullSetWrongbookScreen[];
  wrongQuestionCount: number;
};

export function buildWrongQuestionsOverview(input: {
  basAnswers: PracticeHistoryAnswer[];
  basAttempts: BasWrongQuestionAttempt[];
  basCorrectionAnswers: PracticeHistoryAnswer[];
  basGroupsBySet: Map<string, BasWrongQuestionGroup>;
  readingAnswers: ReadingWrongQuestionAnswer[];
  readingAttempts: ReadingWrongQuestionAttempt[];
  readingCorrectionAnswers?: ReadingWrongQuestionAnswer[];
  readingCorrectionAttempts?: ReadingWrongbookCorrectionAttempt[];
  readingTitles: Map<string, string>;
  fullSetAnswers?: ReadingFullSetWrongQuestionAnswer[];
  fullSetAttempts?: ReadingFullSetWrongQuestionAttempt[];
  fullSetCorrectionAnswers?: ReadingFullSetWrongQuestionAnswer[];
  fullSetCorrectionAttempts?: ReadingFullSetWrongbookCorrectionAttempt[];
  todayEnd: number;
  todayStart: number;
}): WrongQuestionsOverviewPayload {
  const { basHistory, items: basItems } = buildBasWrongQuestionState(input);

  const atomic: AtomicWrongQuestion[] = basItems.map((item) => ({
    actionHref: `/student/results/${encodeURIComponent(item.answer.attemptId)}?source=practice-history`,
    correctionHref: item.corrected ? null : basCorrectionHref(item.groupId),
    corrected: item.corrected,
    firstWrongTime: item.firstWrongTime,
    groupId: item.groupId,
    latestWrongTime: item.latestWrongTime,
    taskType: "build_sentence",
    title: item.title
  }));

  atomic.push(...buildReadingAtomicWrongQuestions(input));
  atomic.push(...buildReadingFullSetAtomicWrongQuestions(input));
  const groups = aggregateWrongQuestionGroups(atomic);
  const corrected = atomic.filter((item) => item.corrected).length;

  return {
    grammarPoints: basHistory.history.grammarPoints,
    groups,
    stats: {
      corrected,
      pending: atomic.length - corrected,
      todayNew: atomic.filter(
        (item) => item.firstWrongTime >= input.todayStart && item.firstWrongTime < input.todayEnd
      ).length,
      total: atomic.length
    }
  };
}

function buildReadingFullSetAtomicWrongQuestions(input: {
  fullSetAnswers?: ReadingFullSetWrongQuestionAnswer[];
  fullSetAttempts?: ReadingFullSetWrongQuestionAttempt[];
  fullSetCorrectionAnswers?: ReadingFullSetWrongQuestionAnswer[];
  fullSetCorrectionAttempts?: ReadingFullSetWrongbookCorrectionAttempt[];
  todayEnd: number;
  todayStart: number;
}) {
  const attempts = input.fullSetAttempts ?? [];
  const attemptById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
  const correctionState = buildReadingFullSetCorrectionState(input);

  return (input.fullSetAnswers ?? []).flatMap((answer): AtomicWrongQuestion[] => {
    if (answer.isCorrect) return [];
    const attempt = attemptById.get(answer.attemptId);
    if (!attempt) return [];
    const corrected = correctionState.get(attempt.attemptId)?.get(readingFullSetAnswerKey(answer)) ?? false;
    const wrongTime = answerTime(attempt.completedAt);
    const scope = wrongTime >= input.todayStart && wrongTime < input.todayEnd ? "today" : "history";
    return [{
      actionHref: `/student/reading/full-sets/${encodeURIComponent(attempt.fullSetId)}/result/${encodeURIComponent(attempt.attemptId)}`,
      correctionHref: corrected ? null : `/student/wrong-questions/${scope}/reading/practice?${new URLSearchParams({
        sourceAttemptId: attempt.attemptId,
        taskType: "full_set"
      }).toString()}`,
      corrected,
      firstWrongTime: wrongTime,
      groupId: attempt.attemptId,
      latestWrongTime: wrongTime,
      taskType: "full_set",
      title: attempt.title
    }];
  });
}

export function buildReadingFullSetWrongbookQueue(input: {
  fullSetAnswers: ReadingFullSetWrongQuestionAnswer[];
  fullSetAttempts: ReadingFullSetWrongQuestionAttempt[];
  fullSetCorrectionAnswers?: ReadingFullSetWrongQuestionAnswer[];
  fullSetCorrectionAttempts?: ReadingFullSetWrongbookCorrectionAttempt[];
  scope: "history" | "today";
  sourceAttemptId?: string | null;
  todayEnd: number;
  todayStart: number;
}): ReadingFullSetWrongbookQueueItem[] {
  const correctionState = buildReadingFullSetCorrectionState(input);
  return input.fullSetAttempts
    .filter((attempt) => !input.sourceAttemptId || attempt.attemptId === input.sourceAttemptId)
    .filter((attempt) => input.scope === "history" || (
      answerTime(attempt.completedAt) >= input.todayStart
      && answerTime(attempt.completedAt) < input.todayEnd
    ))
    .map((attempt) => ({
      fullSetId: attempt.fullSetId,
      latestWrongAt: attempt.completedAt,
      sourceAttemptId: attempt.attemptId,
      targets: input.fullSetAnswers
        .filter((answer) => answer.attemptId === attempt.attemptId && !answer.isCorrect)
        .filter((answer) => !(correctionState.get(attempt.attemptId)?.get(readingFullSetAnswerKey(answer)) ?? false))
        .map(({ attemptId: _attemptId, isCorrect: _isCorrect, ...target }) => target)
        .sort(compareReadingFullSetTargets),
      title: attempt.title
    }))
    .filter((item) => item.targets.length > 0)
    .sort((left, right) => answerTime(right.latestWrongAt) - answerTime(left.latestWrongAt));
}

function buildReadingFullSetCorrectionState(input: {
  fullSetCorrectionAnswers?: ReadingFullSetWrongQuestionAnswer[];
  fullSetCorrectionAttempts?: ReadingFullSetWrongbookCorrectionAttempt[];
}) {
  const correctionAnswersByAttempt = new Map<string, ReadingFullSetWrongQuestionAnswer[]>();
  for (const answer of input.fullSetCorrectionAnswers ?? []) {
    correctionAnswersByAttempt.set(answer.attemptId, [
      ...(correctionAnswersByAttempt.get(answer.attemptId) ?? []),
      answer
    ]);
  }
  const stateBySource = new Map<string, Map<string, boolean>>();
  const orderedAttempts = [...(input.fullSetCorrectionAttempts ?? [])]
    .sort((left, right) => answerTime(left.submittedAt) - answerTime(right.submittedAt));
  for (const attempt of orderedAttempts) {
    const state = stateBySource.get(attempt.sourceAttemptId) ?? new Map<string, boolean>();
    for (const answer of correctionAnswersByAttempt.get(attempt.attemptId) ?? []) {
      state.set(readingFullSetAnswerKey(answer), answer.isCorrect);
    }
    stateBySource.set(attempt.sourceAttemptId, state);
  }
  return stateBySource;
}

export function compareReadingFullSetTargets(
  left: ReadingFullSetWrongbookTarget,
  right: ReadingFullSetWrongbookTarget
) {
  return left.moduleNumber - right.moduleNumber
    || left.order - right.order
    || left.occurrenceId.localeCompare(right.occurrenceId)
    || (left.slotId ?? "").localeCompare(right.slotId ?? "");
}

/**
 * Correction screens and scoring points are deliberately separate: one CTW
 * passage is one screen, while every pending CTW slot remains one wrong question.
 */
export function buildReadingFullSetWrongbookProgress(
  targets: ReadingFullSetWrongbookTarget[]
): ReadingFullSetWrongbookProgress {
  const ordered = [...targets].sort(compareReadingFullSetTargets);
  const groups = new Map<string, ReadingFullSetWrongbookTarget[]>();
  for (const target of ordered) {
    const key = target.taskType === "ctw"
      ? `ctw:${target.occurrenceId}`
      : `${target.taskType}:${target.occurrenceId}:${target.questionId}`;
    groups.set(key, [...(groups.get(key) ?? []), target]);
  }
  let wrongQuestionPosition = 0;
  const screens = Array.from(groups.values()).map((screenTargets) => {
    const first = screenTargets[0]!;
    const wrongQuestionStart = wrongQuestionPosition + 1;
    wrongQuestionPosition += screenTargets.length;
    return {
      occurrenceId: first.occurrenceId,
      questionId: first.questionId,
      taskType: first.taskType,
      wrongQuestionCount: screenTargets.length,
      wrongQuestionEnd: wrongQuestionPosition,
      wrongQuestionStart
    };
  });
  return {
    screenCount: screens.length,
    screens,
    wrongQuestionCount: ordered.length
  };
}

export function readingFullSetWrongbookProgressLabel(
  screen: ReadingFullSetWrongbookScreen,
  wrongQuestionCount: number
) {
  const position = screen.wrongQuestionStart === screen.wrongQuestionEnd
    ? String(screen.wrongQuestionStart)
    : `${screen.wrongQuestionStart}–${screen.wrongQuestionEnd}`;
  return `第 ${position} / ${wrongQuestionCount} 题`;
}

function readingFullSetAnswerKey(answer: Pick<ReadingFullSetWrongQuestionAnswer, "logicalItemId" | "occurrenceId" | "questionId" | "slotId">) {
  return [answer.occurrenceId, answer.logicalItemId, answer.questionId, answer.slotId ?? "question"].join(":");
}

export function buildBasWrongbookEntryQuestionIds(
  input: BasWrongQuestionStateInput & { groupId: string }
) {
  return buildBasWrongQuestionState(input).items
    .filter((item) => item.groupId === input.groupId && !item.corrected)
    .map((item) => item.answer.questionId);
}

export function buildBasWrongbookPracticeQuestionIds(input: {
  answers: BasWrongbookPracticeAnswer[];
  attempts: BasWrongbookPracticeAttempt[];
  scope: "history" | "today";
  todayEnd: number;
  todayStart: number;
}) {
  if (input.scope === "history") {
    return uniqueIds(
      input.answers.filter((answer) => !answer.isCorrect).map((answer) => answer.questionId)
    );
  }

  const attemptById = new Map(input.attempts.map((attempt) => [attempt.attemptId, attempt]));
  const todayAttemptIds = new Set(
    input.attempts
      .filter((attempt) => {
        const time = answerTime(attempt.submittedAt, attempt.createdAt);
        return time >= input.todayStart && time < input.todayEnd;
      })
      .map((attempt) => attempt.attemptId)
  );
  const todayWrongState = new Map<string, boolean>();
  const todayAnswers = input.answers
    .filter((answer) => todayAttemptIds.has(answer.attemptId))
    .sort((left, right) => {
      const leftAttempt = attemptById.get(left.attemptId);
      const rightAttempt = attemptById.get(right.attemptId);
      return answerTime(leftAttempt?.submittedAt, leftAttempt?.createdAt)
        - answerTime(rightAttempt?.submittedAt, rightAttempt?.createdAt);
    });

  for (const answer of todayAnswers) {
    const attempt = attemptById.get(answer.attemptId);
    if (!attempt) continue;
    if (attempt.setId.startsWith("wrongbook-today-")) {
      todayWrongState.set(answer.questionId, !answer.isCorrect);
      continue;
    }
    if (!answer.isCorrect) todayWrongState.set(answer.questionId, true);
  }

  return Array.from(todayWrongState.entries())
    .filter(([, needsReview]) => needsReview)
    .map(([questionId]) => questionId);
}

function buildBasWrongQuestionState(input: BasWrongQuestionStateInput) {
  const basHistory = buildPracticeHistoryPayload({
    answers: input.basAnswers,
    attempts: input.basAttempts,
    correctionAnswers: input.basCorrectionAnswers,
    todayEnd: input.todayEnd,
    todayStart: input.todayStart
  });
  const correctedBasKeys = correctedWrongAnswerKeys(
    input.basAnswers.filter((answer) => !answer.isCorrect),
    input.basCorrectionAnswers,
    basHistory.attempts
  );
  const basAttemptById = new Map(basHistory.attempts.map((attempt) => [attempt.attemptId, attempt]));
  const firstBasWrongAt = new Map<string, number>();

  for (const answer of input.basAnswers) {
    if (answer.isCorrect) continue;
    const key = wrongAnswerDedupeKey(answer);
    const time = answerTime(answer.answeredAt, basAttemptById.get(answer.attemptId)?.submittedAt);
    const existing = firstBasWrongAt.get(key);
    if (existing === undefined || time < existing) firstBasWrongAt.set(key, time);
  }

  const items = basHistory.history.errors.map((answer) => {
    const attempt = basAttemptById.get(answer.attemptId);
    const setId = attempt?.setId ?? "";
    const group = input.basGroupsBySet.get(setId) ?? {
      groupId: setId || answer.attemptId,
      title: attempt?.setTitle || setId || WRONG_QUESTION_TASK_LABELS.build_sentence
    };
    const key = wrongAnswerDedupeKey(answer);
    const latestWrongTime = answerTime(answer.answeredAt, attempt?.submittedAt);
    return {
      answer,
      corrected: correctedBasKeys.has(key),
      firstWrongTime: firstBasWrongAt.get(key) ?? latestWrongTime,
      groupId: group.groupId,
      latestWrongTime,
      title: group.title
    };
  });
  return { basHistory, items };
}

type AtomicWrongQuestion = {
  actionHref: string;
  correctionHref: string | null;
  corrected: boolean;
  firstWrongTime: number;
  groupId: string;
  latestWrongTime: number;
  taskType: WrongQuestionTaskType;
  title: string;
};

function buildReadingAtomicWrongQuestions(input: {
  readingAnswers: ReadingWrongQuestionAnswer[];
  readingAttempts: ReadingWrongQuestionAttempt[];
  readingCorrectionAnswers?: ReadingWrongQuestionAnswer[];
  readingCorrectionAttempts?: ReadingWrongbookCorrectionAttempt[];
  readingTitles: Map<string, string>;
  todayEnd: number;
  todayStart: number;
}) {
  const { attemptById, stateByKey } = buildReadingWrongbookState(input);

  return Array.from(stateByKey.values()).flatMap((state): AtomicWrongQuestion[] => {
    const latestAttempt = attemptById.get(state.latest.attemptId);
    const latestWrongAttempt = attemptById.get(state.latestWrongAttemptId);
    const attempt = latestAttempt ?? latestWrongAttempt;
    if (!attempt) return [];
    return [{
      actionHref: `/student/reading/results/${encodeURIComponent(state.latestWrongAttemptId)}`,
      correctionHref: state.latest.isCorrect
        ? null
        : readingCorrectionHref(
            attempt.taskType,
            attempt.logicalItemId,
            state.latestWrongTime,
            input.todayStart,
            input.todayEnd
          ),
      corrected: state.latest.isCorrect,
      firstWrongTime: state.firstWrongTime,
      groupId: attempt.logicalItemId,
      latestWrongTime: state.latestWrongTime,
      taskType: attempt.taskType,
      title: input.readingTitles.get(attempt.logicalItemId)?.trim()
        || WRONG_QUESTION_TASK_LABELS[attempt.taskType]
    }];
  });
}

export function buildReadingWrongbookQueue(input: {
  readingAnswers: ReadingWrongQuestionAnswer[];
  readingAttempts: ReadingWrongQuestionAttempt[];
  readingCorrectionAnswers?: ReadingWrongQuestionAnswer[];
  readingCorrectionAttempts?: ReadingWrongbookCorrectionAttempt[];
  readingTitles: Map<string, string>;
  scope: "history" | "today";
  taskType: ReadingModule;
  todayEnd: number;
  todayStart: number;
}): ReadingWrongbookQueueItem[] {
  const { attemptById, stateByKey } = buildReadingWrongbookState(input);
  const byItem = new Map<string, ReadingWrongbookQueueItem>();

  for (const state of Array.from(stateByKey.values())) {
    if (state.latest.isCorrect) continue;
    const attempt = attemptById.get(state.latest.attemptId)
      ?? attemptById.get(state.latestWrongAttemptId);
    if (!attempt || attempt.taskType !== input.taskType) continue;
    if (
      input.scope === "today"
      && (state.latestWrongTime < input.todayStart || state.latestWrongTime >= input.todayEnd)
    ) continue;
    const existing = byItem.get(attempt.logicalItemId);
    const target = {
      questionId: state.latest.questionId,
      sourceAttemptId: state.latestWrongAttemptId,
      slotId: state.latest.slotId
    };
    if (!existing) {
      byItem.set(attempt.logicalItemId, {
        latestWrongAt: new Date(state.latestWrongTime).toISOString(),
        latestWrongAttemptId: state.latestWrongAttemptId,
        logicalItemId: attempt.logicalItemId,
        targets: [target],
        taskType: attempt.taskType,
        title: input.readingTitles.get(attempt.logicalItemId)?.trim()
          || WRONG_QUESTION_TASK_LABELS[attempt.taskType]
      });
      continue;
    }
    existing.targets.push(target);
    if (state.latestWrongTime > Date.parse(existing.latestWrongAt)) {
      existing.latestWrongAt = new Date(state.latestWrongTime).toISOString();
      existing.latestWrongAttemptId = state.latestWrongAttemptId;
    }
  }

  return Array.from(byItem.values())
    .map((item) => ({
      ...item,
      targets: [...item.targets].sort((left, right) =>
        left.questionId.localeCompare(right.questionId)
        || (left.slotId ?? "").localeCompare(right.slotId ?? "")
      )
    }))
    .sort((left, right) =>
      Date.parse(right.latestWrongAt) - Date.parse(left.latestWrongAt)
      || left.logicalItemId.localeCompare(right.logicalItemId)
    );
}

function buildReadingWrongbookState(input: {
  readingAnswers: ReadingWrongQuestionAnswer[];
  readingAttempts: ReadingWrongQuestionAttempt[];
  readingCorrectionAnswers?: ReadingWrongQuestionAnswer[];
  readingCorrectionAttempts?: ReadingWrongbookCorrectionAttempt[];
}) {
  const officialAttemptIds = new Set(input.readingAttempts.map((attempt) => attempt.attemptId));
  const attempts = [
    ...input.readingAttempts,
    ...(input.readingCorrectionAttempts ?? [])
  ];
  const attemptById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
  const stateByKey = new Map<string, {
    firstWrongTime: number;
    latest: ReadingWrongQuestionAnswer;
    latestTime: number;
    latestWrongAttemptId: string;
    latestWrongTime: number;
  }>();
  const answers = [
    ...input.readingAnswers,
    ...(input.readingCorrectionAnswers ?? [])
  ].sort((left, right) => {
    const leftAttempt = attemptById.get(left.attemptId);
    const rightAttempt = attemptById.get(right.attemptId);
    return answerTime(leftAttempt?.submittedAt) - answerTime(rightAttempt?.submittedAt)
      || left.attemptId.localeCompare(right.attemptId);
  });

  for (const answer of answers) {
    const attempt = attemptById.get(answer.attemptId);
    if (!attempt) continue;
    const time = answerTime(attempt.submittedAt);
    const key = readingAnswerKey(answer, attempt);
    const existing = stateByKey.get(key);
    const official = officialAttemptIds.has(answer.attemptId);

    if (!existing) {
      // Correction sessions may only update a canonical wrong item created by
      // ordinary Reading practice; they never create a second wrongbook identity.
      if (!official || answer.isCorrect) continue;
      stateByKey.set(key, {
        firstWrongTime: time,
        latest: answer,
        latestTime: time,
        latestWrongAttemptId: answer.attemptId,
        latestWrongTime: time
      });
      continue;
    }

    if (official && !answer.isCorrect && time < existing.firstWrongTime) {
      existing.firstWrongTime = time;
    }
    if (official && !answer.isCorrect && time >= existing.latestWrongTime) {
      existing.latestWrongAttemptId = answer.attemptId;
      existing.latestWrongTime = time;
    }
    if (time >= existing.latestTime) {
      existing.latest = answer;
      existing.latestTime = time;
    }
  }

  return { attemptById, stateByKey };
}

function aggregateWrongQuestionGroups(items: AtomicWrongQuestion[]) {
  const groups = new Map<string, WrongQuestionGroup & { correctionCandidateTime: number }>();
  for (const item of items) {
    const key = `${item.taskType}:${item.groupId}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        actionHref: item.actionHref,
        correctionCandidateTime: item.correctionHref ? item.latestWrongTime : Number.NEGATIVE_INFINITY,
        correctionHref: item.correctionHref,
        correctedCount: item.corrected ? 1 : 0,
        groupId: item.groupId,
        latestWrongAt: new Date(item.latestWrongTime).toISOString(),
        pendingCount: item.corrected ? 0 : 1,
        taskLabel: WRONG_QUESTION_TASK_LABELS[item.taskType],
        taskType: item.taskType,
        title: item.title,
        wrongCount: 1
      });
      continue;
    }
    existing.wrongCount += 1;
    existing.correctedCount += item.corrected ? 1 : 0;
    existing.pendingCount += item.corrected ? 0 : 1;
    if (item.correctionHref && item.latestWrongTime > existing.correctionCandidateTime) {
      existing.correctionCandidateTime = item.latestWrongTime;
      existing.correctionHref = item.correctionHref;
    }
    if (item.latestWrongTime > Date.parse(existing.latestWrongAt)) {
      existing.actionHref = item.actionHref;
      existing.latestWrongAt = new Date(item.latestWrongTime).toISOString();
    }
  }
  return Array.from(groups.values())
    .map(({ correctionCandidateTime: _correctionCandidateTime, ...group }) => group)
    .sort((left, right) =>
      Date.parse(right.latestWrongAt) - Date.parse(left.latestWrongAt)
      || left.taskType.localeCompare(right.taskType)
      || left.title.localeCompare(right.title)
    );
}

function basCorrectionHref(groupId: string) {
  return `/student/wrong-questions/history/practice?${new URLSearchParams({
    scope: "entry",
    groupId
  }).toString()}`;
}

function readingCorrectionHref(
  taskType: ReadingModule,
  logicalItemId: string,
  latestWrongTime: number,
  todayStart: number,
  todayEnd: number
) {
  const scope = latestWrongTime >= todayStart && latestWrongTime < todayEnd
    ? "today"
    : "history";
  return `/student/wrong-questions/${scope}/reading/practice?${new URLSearchParams({
    itemId: logicalItemId,
    taskType
  }).toString()}`;
}

function readingAnswerKey(
  answer: ReadingWrongQuestionAnswer,
  attempt: ReadingWrongQuestionAttempt
) {
  return [
    attempt.taskType,
    attempt.logicalItemId,
    answer.questionId,
    answer.slotId ?? "question"
  ].join(":");
}

function answerTime(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const time = Date.parse(value ?? "");
    if (Number.isFinite(time)) return time;
  }
  return 0;
}

function uniqueIds(ids: string[]) {
  return Array.from(new Set(ids.filter(Boolean)));
}
