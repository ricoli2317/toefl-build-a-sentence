const READING_QUESTION_TIMES_PREFIX = "reading:question-times:v1";

export type ReadingQuestionTimes = Record<string, number>;

export function storeReadingQuestionTimes(attemptId: string, times: ReadingQuestionTimes) {
  if (typeof window === "undefined") return;
  const normalized = normalizeQuestionTimes(times);
  try {
    window.localStorage.setItem(
      questionTimesKey(attemptId),
      JSON.stringify(normalized)
    );
  } catch {
    // Result detail remains usable if browser storage is unavailable.
  }
}

export function normalizeQuestionTimes(times: ReadingQuestionTimes) {
  return Object.fromEntries(Object.entries(times).flatMap(([questionId, seconds]) =>
    questionId && Number.isFinite(seconds) && seconds >= 0
      ? [[questionId, Math.round(seconds)]]
      : []
  ));
}

function questionTimesKey(attemptId: string) {
  return `${READING_QUESTION_TIMES_PREFIX}:${attemptId}`;
}
