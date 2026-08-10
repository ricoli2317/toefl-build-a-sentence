export type PracticeHistoryAttempt = {
  attemptId: string;
  setId: string;
  setTitle: string;
  correctCount: number;
  totalQuestions: number;
  accuracy: number;
  timeSpentSeconds: number;
  submittedAt: string | null;
};

export type PracticeHistoryAnswer = {
  attemptAnswerId: string;
  attemptId: string;
  questionId: string;
  questionOrder: number;
  prompt: string;
  sentenceTemplate: string;
  optionsText: string;
  finalSentence: string;
  grammarTag: string;
  submittedOrderText: string;
  isCorrect: boolean;
  questionTimeSeconds: number | null;
  answeredAt: string | null;
};

export type PracticeHistorySetSummary = {
  setId: string;
  setTitle: string;
  attemptCount: number;
  averageAccuracy: number;
  bestAccuracy: number;
  latestAccuracy: number;
  latestSubmittedAt: string | null;
};

export type PracticeHistoryGrammarSummary = {
  tag: string;
  count: number;
};

export type PracticeHistoryScopeSummary = {
  setCount: number;
  averageAccuracy: number | null;
  errorCount: number;
  correctedCount: number;
  sets: PracticeHistorySetSummary[];
  errors: PracticeHistoryAnswer[];
  grammarPoints: PracticeHistoryGrammarSummary[];
};

export type PracticeHistoryPayload = {
  today: PracticeHistoryScopeSummary;
  history: PracticeHistoryScopeSummary;
  attempts: PracticeHistoryAttempt[];
  answers: PracticeHistoryAnswer[];
  missingAnswerAttemptIds: string[];
};

type AttemptInput = Omit<PracticeHistoryAttempt, "accuracy">;
type AnswerInput = PracticeHistoryAnswer;

export function isVirtualSetId(setId: string) {
  const normalized = setId.trim().toLocaleLowerCase();
  return normalized.startsWith("wrongbook-") || normalized.startsWith("grammar-");
}

export function isOfficialPracticeSetId(setId: string, realSetIds: Set<string>) {
  const normalized = setId.trim();
  return Boolean(normalized) && !isVirtualSetId(normalized) && realSetIds.has(normalized);
}

export function normalizeFinalSentence(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

export function wrongAnswerDedupeKey(answer: Pick<PracticeHistoryAnswer, "finalSentence" | "questionId">) {
  const sentence = normalizeFinalSentence(answer.finalSentence);
  return sentence ? `sentence:${sentence}` : `question:${answer.questionId}`;
}

export function buildPracticeHistoryPayload({
  answers,
  attempts,
  correctionAnswers = [],
  todayEnd,
  todayStart
}: {
  answers: AnswerInput[];
  attempts: AttemptInput[];
  correctionAnswers?: AnswerInput[];
  todayEnd: number;
  todayStart: number;
}): PracticeHistoryPayload {
  const normalizedAttempts = attempts
    .map((attempt) => ({
      ...attempt,
      accuracy: ratio(attempt.correctCount, attempt.totalQuestions)
    }))
    .sort((left, right) => compareDatesDesc(left.submittedAt, right.submittedAt));
  const attemptById = new Map(
    normalizedAttempts.map((attempt) => [attempt.attemptId, attempt])
  );
  const normalizedAnswers = answers
    .filter((answer) => attemptById.has(answer.attemptId))
    .sort((left, right) => compareAnswerDatesDesc(left, right, attemptById));
  const answerAttemptIds = new Set(normalizedAnswers.map((answer) => answer.attemptId));
  const todayAttempts = normalizedAttempts.filter((attempt) => {
    const time = dateTime(attempt.submittedAt);
    return time >= todayStart && time < todayEnd;
  });

  return {
    today: summarizeScope(todayAttempts, normalizedAnswers, correctionAnswers),
    history: summarizeScope(normalizedAttempts, normalizedAnswers, correctionAnswers),
    attempts: normalizedAttempts,
    answers: normalizedAnswers,
    missingAnswerAttemptIds: normalizedAttempts
      .filter((attempt) => !answerAttemptIds.has(attempt.attemptId))
      .map((attempt) => attempt.attemptId)
  };
}

function summarizeScope(
  attempts: PracticeHistoryAttempt[],
  allAnswers: PracticeHistoryAnswer[],
  correctionAnswers: PracticeHistoryAnswer[]
): PracticeHistoryScopeSummary {
  const attemptIds = new Set(attempts.map((attempt) => attempt.attemptId));
  const answers = allAnswers.filter((answer) => attemptIds.has(answer.attemptId));
  const errors = dedupeWrongAnswers(answers.filter((answer) => !answer.isCorrect), attempts);
  const sets = summarizeSets(attempts);
  const grammarCounts = new Map<string, number>();

  for (const error of errors) {
    const tag = error.grammarTag.trim();
    if (tag) grammarCounts.set(tag, (grammarCounts.get(tag) ?? 0) + 1);
  }

  return {
    setCount: sets.length,
    averageAccuracy:
      sets.length === 0
        ? null
        : sets.reduce((sum, set) => sum + set.averageAccuracy, 0) / sets.length,
    errorCount: errors.length,
    correctedCount: countCorrectedWrongAnswers(
      answers.filter((answer) => !answer.isCorrect),
      correctionAnswers,
      attempts
    ),
    sets,
    errors,
    grammarPoints: Array.from(grammarCounts, ([tag, count]) => ({ tag, count })).sort(
      (left, right) => right.count - left.count || left.tag.localeCompare(right.tag)
    )
  };
}

function countCorrectedWrongAnswers(
  wrongAnswers: PracticeHistoryAnswer[],
  correctionAnswers: PracticeHistoryAnswer[],
  attempts: PracticeHistoryAttempt[]
) {
  const attemptById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
  const firstWrongTimeByKey = new Map<string, number>();

  for (const answer of wrongAnswers) {
    const key = wrongAnswerDedupeKey(answer);
    const time = answerEventTime(answer, attemptById);
    const existing = firstWrongTimeByKey.get(key);
    if (existing === undefined || time < existing) firstWrongTimeByKey.set(key, time);
  }

  const correctedKeys = new Set<string>();
  for (const answer of correctionAnswers) {
    if (!answer.isCorrect) continue;
    const key = wrongAnswerDedupeKey(answer);
    const wrongTime = firstWrongTimeByKey.get(key);
    if (wrongTime === undefined) continue;
    if (dateTime(answer.answeredAt) > wrongTime) correctedKeys.add(key);
  }

  return correctedKeys.size;
}

function summarizeSets(attempts: PracticeHistoryAttempt[]) {
  const bySet = new Map<string, PracticeHistoryAttempt[]>();
  for (const attempt of attempts) {
    bySet.set(attempt.setId, [...(bySet.get(attempt.setId) ?? []), attempt]);
  }

  return Array.from(bySet, ([setId, setAttempts]) => {
    const sorted = [...setAttempts].sort((left, right) =>
      compareDatesDesc(left.submittedAt, right.submittedAt)
    );
    return {
      setId,
      setTitle: sorted[0]?.setTitle ?? setId,
      attemptCount: sorted.length,
      averageAccuracy:
        sorted.reduce((sum, attempt) => sum + attempt.accuracy, 0) / sorted.length,
      bestAccuracy: Math.max(...sorted.map((attempt) => attempt.accuracy)),
      latestAccuracy: sorted[0]?.accuracy ?? 0,
      latestSubmittedAt: sorted[0]?.submittedAt ?? null
    };
  }).sort((left, right) => compareDatesDesc(left.latestSubmittedAt, right.latestSubmittedAt));
}

function dedupeWrongAnswers(
  answers: PracticeHistoryAnswer[],
  attempts: PracticeHistoryAttempt[]
) {
  const attemptById = new Map(attempts.map((attempt) => [attempt.attemptId, attempt]));
  const latestByKey = new Map<string, PracticeHistoryAnswer>();

  for (const answer of answers) {
    const key = wrongAnswerDedupeKey(answer);
    const existing = latestByKey.get(key);
    if (!existing || compareAnswerDatesDesc(answer, existing, attemptById) < 0) {
      latestByKey.set(key, answer);
    }
  }

  return Array.from(latestByKey.values()).sort((left, right) =>
    compareAnswerDatesDesc(left, right, attemptById)
  );
}

function compareAnswerDatesDesc(
  left: Pick<PracticeHistoryAnswer, "answeredAt" | "attemptId">,
  right: Pick<PracticeHistoryAnswer, "answeredAt" | "attemptId">,
  attemptById: Map<string, Pick<PracticeHistoryAttempt, "submittedAt">>
) {
  const leftTime = dateTime(left.answeredAt ?? attemptById.get(left.attemptId)?.submittedAt ?? null);
  const rightTime = dateTime(right.answeredAt ?? attemptById.get(right.attemptId)?.submittedAt ?? null);
  return rightTime - leftTime;
}

function answerEventTime(
  answer: Pick<PracticeHistoryAnswer, "answeredAt" | "attemptId">,
  attemptById: Map<string, Pick<PracticeHistoryAttempt, "submittedAt">>
) {
  return dateTime(answer.answeredAt ?? attemptById.get(answer.attemptId)?.submittedAt ?? null);
}

function compareDatesDesc(left: string | null, right: string | null) {
  return dateTime(right) - dateTime(left);
}

function dateTime(value: string | null) {
  const time = new Date(value ?? 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function ratio(correct: number, total: number) {
  return total > 0 ? correct / total : 0;
}
