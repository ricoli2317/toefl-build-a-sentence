import type {
  ReadingFullSetOccurrencePracticePayload,
  ReadingFullSetRunnerOccurrence,
  ReadingFullSetRunnerPosition
} from "./fullSetAttempts.ts";
import type { ReadingAnswer, ReadingAnswerState } from "./practiceState.ts";
import type { StudentReadingPracticePayload } from "./studentPractice.ts";
import type { ReadingModule } from "./types.ts";

export type ReadingFullSetActiveReviewItem = {
  completed: boolean;
  key: string;
  label: string;
  moduleAttemptId: string;
  occurrenceId: string;
  occurrenceIndex: number;
  questionIndex: number;
  questionNumber: number;
  scoringPointIndex: number;
  taskType: ReadingModule;
};

export type ReadingFullSetReviewAnswerRow = {
  occurrenceId: string;
  questionId: string;
  slotId: string | null;
  studentAnswer: string | null;
};

export type ReadingFullSetReviewQuestionOccurrence = {
  occurrenceId: string;
  questionId: string;
  sourceQuestionStart: number;
};

export type ReadingFullSetReviewSlot = {
  questionId: string;
  slotId: string;
  slotOrder: number;
};

export function buildReadingFullSetActiveReviewItems(input: {
  answersByOccurrence: Record<string, ReadingAnswerState>;
  completedQuestionNumbers?: ReadonlySet<number>;
  moduleAttemptId: string;
  occurrencePayloads: Record<string, ReadingFullSetOccurrencePracticePayload>;
  occurrences: ReadingFullSetRunnerOccurrence[];
}): ReadingFullSetActiveReviewItem[] {
  return input.occurrences.flatMap((occurrence, occurrenceIndex) =>
    Array.from(
      { length: occurrence.sourceQuestionEnd - occurrence.sourceQuestionStart + 1 },
      (_, scoringPointIndex) => {
        const questionNumber = occurrence.sourceQuestionStart + scoringPointIndex;
        const payload = input.occurrencePayloads[occurrence.occurrenceId];
        return {
          completed: payload
            ? readingFullSetScoringPointCompleted(
                payload.practice,
                input.answersByOccurrence[occurrence.occurrenceId] ?? {},
                scoringPointIndex
              )
            : input.completedQuestionNumbers?.has(questionNumber) ?? false,
          key: `${input.moduleAttemptId}:${occurrence.occurrenceId}:${questionNumber}`,
          label: String(questionNumber),
          moduleAttemptId: input.moduleAttemptId,
          occurrenceId: occurrence.occurrenceId,
          occurrenceIndex,
          questionIndex: occurrence.taskType === "ctw" ? 0 : scoringPointIndex,
          questionNumber,
          scoringPointIndex,
          taskType: occurrence.taskType
        };
      }
    )
  );
}

export function readingFullSetScoringPointCompleted(
  practice: StudentReadingPracticePayload,
  answers: ReadingAnswerState,
  scoringPointIndex: number
) {
  if (practice.item.module === "ctw") {
    const question = practice.questions[0];
    if (!question || question.questionType !== "ctw") return false;
    const slot = [...question.slots]
      .sort((left, right) => left.slotOrder - right.slotOrder)[scoringPointIndex];
    const answer = answers[question.questionId];
    if (!slot || answer?.kind !== "ctw") return false;
    const characters = answer.slots[slot.slotId] ?? [];
    return characters.length === slot.missingLength
      && characters.every((character) => Boolean(character.trim()));
  }

  const question = practice.questions[scoringPointIndex];
  return Boolean(question && readingAnswerCompleted(answers[question.questionId]));
}

export function readingFullSetActiveReviewIndex(
  items: ReadingFullSetActiveReviewItem[],
  position: ReadingFullSetRunnerPosition,
  ctwScoringPointIndex: number
) {
  const index = items.findIndex((item) =>
    item.occurrenceIndex === position.occurrenceIndex
    && item.questionIndex === position.questionIndex
    && (item.taskType !== "ctw" || item.scoringPointIndex === ctwScoringPointIndex)
  );
  return index >= 0 ? index : 0;
}

export function readingFullSetActiveReviewTarget(
  item: ReadingFullSetActiveReviewItem,
  moduleAttemptId: string,
  occurrences: ReadingFullSetRunnerOccurrence[]
): ReadingFullSetRunnerPosition | null {
  if (item.moduleAttemptId !== moduleAttemptId) return null;
  const occurrence = occurrences[item.occurrenceIndex];
  if (
    !occurrence
    || occurrence.occurrenceId !== item.occurrenceId
    || occurrence.taskType !== item.taskType
    || item.questionNumber < occurrence.sourceQuestionStart
    || item.questionNumber > occurrence.sourceQuestionEnd
    || item.scoringPointIndex !== item.questionNumber - occurrence.sourceQuestionStart
  ) return null;
  const questionIndex = occurrence.taskType === "ctw" ? 0 : item.scoringPointIndex;
  if (item.questionIndex !== questionIndex) return null;
  return { occurrenceIndex: item.occurrenceIndex, questionIndex };
}

export function readingFullSetCompletedQuestionNumbersFromRows(input: {
  answers: ReadingFullSetReviewAnswerRow[];
  occurrences: ReadingFullSetRunnerOccurrence[];
  questionOccurrences: ReadingFullSetReviewQuestionOccurrence[];
  slots: ReadingFullSetReviewSlot[];
}) {
  const occurrenceById = new Map(input.occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
  const questionNumberByKey = new Map(input.questionOccurrences.map((row) => [
    `${row.occurrenceId}:${row.questionId}`,
    row.sourceQuestionStart
  ]));
  const slotOrderByKey = new Map(input.slots.map((row) => [
    `${row.questionId}:${row.slotId}`,
    row.slotOrder
  ]));
  const completed = new Set<number>();
  for (const answer of input.answers) {
    if (!answer.studentAnswer?.trim()) continue;
    const occurrence = occurrenceById.get(answer.occurrenceId);
    if (!occurrence) continue;
    const slotOrder = answer.slotId
      ? slotOrderByKey.get(`${answer.questionId}:${answer.slotId}`)
      : undefined;
    const questionNumber = occurrence.taskType === "ctw"
      ? slotOrder === undefined ? undefined : occurrence.sourceQuestionStart + slotOrder - 1
      : questionNumberByKey.get(`${answer.occurrenceId}:${answer.questionId}`);
    if (
      questionNumber !== undefined
      && questionNumber >= occurrence.sourceQuestionStart
      && questionNumber <= occurrence.sourceQuestionEnd
    ) completed.add(questionNumber);
  }
  return Array.from(completed).sort((left, right) => left - right);
}

function readingAnswerCompleted(answer: ReadingAnswer | undefined) {
  if (!answer) return false;
  if (answer.kind === "choice") return Boolean(answer.optionId);
  if (answer.kind === "insertion") return Boolean(answer.anchorId);
  if (answer.kind === "sentence_selection") return Boolean(answer.sentenceId);
  return false;
}
