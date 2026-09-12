import type { ReadingAnswerState } from "./practiceState.ts";
import type { ReadingFullSetResultAnswer } from "./fullSetResults.ts";
import type { StudentReadingPracticePayload } from "./studentPractice.ts";
import type { ReadingModule } from "./types.ts";

export type ReadingFullSetReviewItem = {
  key: string;
  moduleNumber: 1 | 2;
  occurrenceId: string;
  taskType: ReadingModule;
  orderStart: number;
  orderEnd: number;
  isAnswered: boolean;
  isCorrect: boolean;
  questionId: string;
  questionTimeSeconds: number | null;
  sourceAnswerIndex: number;
  slotReviews: ReadingFullSetResultAnswer[];
  href?: string;
};

export type ReadingFullSetReviewOccurrence = {
  occurrenceId: string;
  moduleNumber: 1 | 2;
  answers: ReadingAnswerState;
  practice: StudentReadingPracticePayload;
};

export type ReadingFullSetReviewPayload = {
  attempt: {
    attemptId: string;
    fullSetId: string;
    title: string;
  };
  occurrences: ReadingFullSetReviewOccurrence[];
  reviewItems: ReadingFullSetReviewItem[];
};

export function buildReadingFullSetReviewItems(
  answers: ReadingFullSetResultAnswer[],
  reviewHref: (sourceAnswerIndex: number) => string
): ReadingFullSetReviewItem[] {
  const items: ReadingFullSetReviewItem[] = [];
  const occurrenceGroups = new Map<string, ReadingFullSetResultAnswer[]>();
  for (const answer of answers) {
    const group = occurrenceGroups.get(answer.occurrenceId) ?? [];
    group.push(answer);
    occurrenceGroups.set(answer.occurrenceId, group);
  }

  for (const moduleNumber of [1, 2] as const) {
    const moduleGroups = Array.from(occurrenceGroups.values())
      .filter((group) => group[0]?.moduleNumber === moduleNumber)
      .map((group) => [...group].sort((left, right) => left.order - right.order || left.index - right.index))
      .sort((left, right) => (left[0]?.order ?? 0) - (right[0]?.order ?? 0));
    const reviewGroups = [
      ...moduleGroups.filter((group) => group[0]?.taskType === "ctw"),
      ...moduleGroups.filter((group) => group[0]?.taskType !== "ctw")
    ];
    let displayOrder = 1;
    for (const ordered of reviewGroups) {
      const first = ordered[0];
      if (!first) continue;
      if (first.taskType === "ctw") {
        const orderStart = displayOrder;
        const orderEnd = displayOrder + ordered.length - 1;
        displayOrder = orderEnd + 1;
        items.push({
          key: `ctw:${first.occurrenceId}`,
          moduleNumber,
          occurrenceId: first.occurrenceId,
          taskType: first.taskType,
          orderStart,
          orderEnd,
          isAnswered: ordered.some((answer) => answer.isAnswered),
          isCorrect: ordered.every((answer) => answer.isCorrect),
          questionId: first.questionId,
          questionTimeSeconds: aggregateCtwInteractionTime(ordered),
          sourceAnswerIndex: first.index,
          slotReviews: ordered,
          href: reviewHref(first.index)
        });
        continue;
      }
      for (const answer of ordered) {
        items.push({
          key: `answer:${answer.answerId}`,
          moduleNumber,
          occurrenceId: answer.occurrenceId,
          taskType: answer.taskType,
          orderStart: displayOrder,
          orderEnd: displayOrder,
          isAnswered: answer.isAnswered,
          isCorrect: answer.isCorrect,
          questionId: answer.questionId,
          questionTimeSeconds: answer.questionTimeSeconds,
          sourceAnswerIndex: answer.index,
          slotReviews: [answer],
          href: reviewHref(answer.index)
        });
        displayOrder += 1;
      }
    }
  }
  return items;
}

/**
 * Full Set currently measures a CTW as one question interaction and persists
 * that cumulative value on every slot row. De-duplicate those copies with the
 * maximum value. Requiring every slot to have timing keeps incomplete history
 * unknown instead of manufacturing a total.
 */
export function aggregateCtwInteractionTime(
  answers: Pick<ReadingFullSetResultAnswer, "questionTimeSeconds">[]
) {
  if (!answers.length || answers.some((answer) => answer.questionTimeSeconds === null)) return null;
  return Math.max(...answers.map((answer) => answer.questionTimeSeconds as number));
}

export function findReadingFullSetReviewIndex(
  items: ReadingFullSetReviewItem[],
  sourceAnswerIndex: number
) {
  const exact = items.findIndex((item) => item.sourceAnswerIndex === sourceAnswerIndex);
  if (exact >= 0) return exact;
  const containing = items.findIndex((item) =>
    item.slotReviews.some((answer) => answer.index === sourceAnswerIndex)
  );
  return containing >= 0 ? containing : 0;
}

export function readingFullSetReviewTotalTime(
  answers: ReadingFullSetResultAnswer[]
) {
  const items = buildReadingFullSetReviewItems(answers, () => "");
  if (items.some((item) => item.questionTimeSeconds === null)) return null;
  return items.reduce((sum, item) => sum + (item.questionTimeSeconds ?? 0), 0);
}

export function readingFullSetReviewItemLabel(item: ReadingFullSetReviewItem) {
  return item.orderStart === item.orderEnd
    ? String(item.orderStart)
    : `${item.orderStart}–${item.orderEnd}`;
}
