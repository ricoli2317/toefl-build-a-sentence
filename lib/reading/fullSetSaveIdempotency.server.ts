type ComparableAnswer = {
  answerKind: string;
  questionId: string;
  questionTimeSeconds: number | null;
  slotId: string | null;
  studentAnswer: string | null;
};

export function sameReadingFullSetAnswers(incoming: unknown, saved: unknown) {
  const incomingAnswers = comparableIncomingAnswers(incoming);
  const savedAnswers = comparableSavedAnswers(saved);
  if (!incomingAnswers || !savedAnswers || incomingAnswers.length !== savedAnswers.length) return false;
  return incomingAnswers.every((answer, index) =>
    JSON.stringify(answer) === JSON.stringify(savedAnswers[index])
  );
}

function comparableIncomingAnswers(value: unknown): ComparableAnswer[] | null {
  if (!Array.isArray(value)) return null;
  const answers: ComparableAnswer[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const answer = entry as Record<string, unknown>;
    if (
      typeof answer.kind !== "string"
      || typeof answer.questionId !== "string"
      || !Number.isInteger(answer.questionTimeSeconds)
      || (answer.slotId !== undefined && typeof answer.slotId !== "string")
      || (answer.studentAnswer !== null && typeof answer.studentAnswer !== "string")
    ) return null;
    answers.push({
      answerKind: answer.kind,
      questionId: answer.questionId,
      questionTimeSeconds: Number(answer.questionTimeSeconds),
      slotId: typeof answer.slotId === "string" ? answer.slotId : null,
      studentAnswer: typeof answer.studentAnswer === "string" ? answer.studentAnswer : null
    });
  }
  return sortComparableAnswers(answers);
}

function comparableSavedAnswers(value: unknown): ComparableAnswer[] | null {
  if (!Array.isArray(value)) return null;
  const answers: ComparableAnswer[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const answer = entry as Record<string, unknown>;
    if (
      typeof answer.answer_kind !== "string"
      || typeof answer.question_id !== "string"
      || (answer.question_time_seconds !== null && !Number.isInteger(answer.question_time_seconds))
      || (answer.slot_id !== null && typeof answer.slot_id !== "string")
      || (answer.student_answer !== null && typeof answer.student_answer !== "string")
    ) return null;
    answers.push({
      answerKind: answer.answer_kind,
      questionId: answer.question_id,
      questionTimeSeconds: answer.question_time_seconds === null
        ? null
        : Number(answer.question_time_seconds),
      slotId: typeof answer.slot_id === "string" ? answer.slot_id : null,
      studentAnswer: typeof answer.student_answer === "string" ? answer.student_answer : null
    });
  }
  return sortComparableAnswers(answers);
}

function sortComparableAnswers(answers: ComparableAnswer[]) {
  return answers.sort((left, right) =>
    left.questionId.localeCompare(right.questionId)
    || (left.slotId ?? "").localeCompare(right.slotId ?? "")
    || left.answerKind.localeCompare(right.answerKind)
  );
}
