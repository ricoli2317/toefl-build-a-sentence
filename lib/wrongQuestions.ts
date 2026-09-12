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
  "rap"
] as const;

export type WrongQuestionTaskType = (typeof WRONG_QUESTION_TASK_TYPES)[number];

export const WRONG_QUESTION_TASK_LABELS: Record<WrongQuestionTaskType, string> = {
  build_sentence: "Build a Sentence",
  ctw: "Complete the Words",
  rdl: "Read in Daily Life",
  rap: "Read an Academic Passage"
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
  todayEnd: number;
  todayStart: number;
}): WrongQuestionsOverviewPayload {
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

  const atomic: AtomicWrongQuestion[] = basHistory.history.errors.map((answer) => {
    const attempt = basAttemptById.get(answer.attemptId);
    const setId = attempt?.setId ?? "";
    const group = input.basGroupsBySet.get(setId) ?? {
      groupId: setId || answer.attemptId,
      title: attempt?.setTitle || setId || WRONG_QUESTION_TASK_LABELS.build_sentence
    };
    const key = wrongAnswerDedupeKey(answer);
    const latestWrongTime = answerTime(answer.answeredAt, attempt?.submittedAt);
    return {
      actionHref: `/student/results/${encodeURIComponent(answer.attemptId)}?source=practice-history`,
      correctionHref: correctedBasKeys.has(key)
        ? null
        : basCorrectionHref(latestWrongTime, input.todayStart, input.todayEnd),
      corrected: correctedBasKeys.has(key),
      firstWrongTime: firstBasWrongAt.get(key) ?? latestWrongTime,
      groupId: group.groupId,
      latestWrongTime,
      taskType: "build_sentence",
      title: group.title
    };
  });

  atomic.push(...buildReadingAtomicWrongQuestions(input));
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

function basCorrectionHref(
  latestWrongTime: number,
  todayStart: number,
  todayEnd: number
) {
  const today = latestWrongTime >= todayStart && latestWrongTime < todayEnd;
  return today
    ? "/student/wrong-questions/today/practice"
    : "/student/wrong-questions/history/practice?mode=all";
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
