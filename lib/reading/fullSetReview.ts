import type { ReadingAnswerState } from "./practiceState.ts";
import type { ReadingFullSetResultAnswer } from "./fullSetResults.ts";
import type { StudentReadingPracticePayload } from "./studentPractice.ts";
import type { ReadingModule } from "./types.ts";
import type { ReadingCorrectionAnswerPresentation } from "./correctionResult.ts";

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
  disclosures: Record<string, ReadingCorrectionAnswerPresentation>;
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
        const interactionTime = aggregateCtwInteractionTime(ordered);
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
            questionTimeSeconds: interactionTime,
            sourceAnswerIndex: answer.index,
            // Every slot navigation item keeps the complete CTW review so the
            // paragraph stays mounted while only the active slot changes.
            slotReviews: ordered,
            href: reviewHref(answer.index)
          });
          displayOrder += 1;
        }
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
 * Slot-level timing is additive. Older Full Set attempts stored one CTW
 * interaction value on every slot row, so an entirely identical set remains a
 * single legacy interaction value. Requiring every slot to have timing keeps
 * incomplete history unknown instead of manufacturing a total.
 */
export function aggregateCtwInteractionTime(
  answers: Pick<ReadingFullSetResultAnswer, "questionTimeSeconds">[]
) {
  if (!answers.length || answers.some((answer) => answer.questionTimeSeconds === null)) return null;
  const values = answers.map((answer) => answer.questionTimeSeconds as number);
  return new Set(values).size === 1
    ? values[0]
    : values.reduce((sum, value) => sum + value, 0);
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
  const countedCtwOccurrences = new Set<string>();
  let total = 0;
  for (const item of items) {
    if (item.questionTimeSeconds === null) return null;
    if (item.taskType === "ctw") {
      if (countedCtwOccurrences.has(item.occurrenceId)) continue;
      countedCtwOccurrences.add(item.occurrenceId);
    }
    total += item.questionTimeSeconds;
  }
  return total;
}

export function readingFullSetReviewItemLabel(item: ReadingFullSetReviewItem) {
  return item.orderStart === item.orderEnd
    ? String(item.orderStart)
    : `${item.orderStart}–${item.orderEnd}`;
}
