import type { WrongQuestionSessionGroup } from "../wrongQuestionBank.ts";
import type {
  ReadingCorrectionAnswerPresentation,
  ReadingCorrectionResultPayload
} from "./correctionResult.ts";
import type { ReadingFullSetResultAnswer } from "./fullSetResults.ts";
import type {
  ReadingFullSetReviewItem,
  ReadingFullSetReviewOccurrence
} from "./fullSetReview.ts";
import type { SubmittedReadingReviewItem, SubmittedReadingReviewPayload } from "./review.ts";
import type { ReadingModule } from "./types.ts";

/**
 * One scoring point of a frozen wrong-question session in the exact order the
 * student meets it: groups as frozen at session creation, questions inside a
 * group in canonical order, and a continuous global index that never restarts
 * per source.
 */
export type ReadingWrongbookSessionStep = {
  /** 0-based global scoring-point index across the whole session. */
  globalIndex: number;
  groupIndex: number;
  localIndex: number;
  group: WrongQuestionSessionGroup;
  questionId: string;
  slotId: string | null;
};

export function buildReadingWrongbookSessionSteps(
  groups: WrongQuestionSessionGroup[]
): ReadingWrongbookSessionStep[] {
  const steps: ReadingWrongbookSessionStep[] = [];
  groups.forEach((group, groupIndex) => {
    group.targets.forEach((target, localIndex) => {
      steps.push({
        globalIndex: steps.length,
        groupIndex,
        localIndex,
        group,
        questionId: target.questionId,
        slotId: target.slotId
      });
    });
  });
  return steps;
}

/** 0-based global start of each group's scoring points. */
export function readingWrongbookSessionGroupStarts(groups: WrongQuestionSessionGroup[]) {
  let offset = 0;
  return groups.map((group) => {
    const start = offset;
    offset += group.targets.length;
    return start;
  });
}

/**
 * Global session numbering rule (4D): a workspace that maps to exactly one
 * scoring point shows `第 X / N 题`; a workspace covering several consecutive
 * scoring points shows `第 X–Y / N 题`. `X–X` never appears, and numbering is
 * always session-global (never per source).
 */
export function readingWrongbookSessionProgressLabel(input: {
  currentIndex: number;
  groupStart: number;
  module: ReadingModule;
  targetCount: number;
  totalPoints: number;
}) {
  const total = Math.max(1, input.totalPoints);
  if (input.module === "ctw") {
    const start = input.groupStart + 1;
    const count = Math.max(1, input.targetCount);
    const end = input.groupStart + count;
    return end === start
      ? `第 ${start} / ${total} 题`
      : `第 ${start}–${end} / ${total} 题`;
  }
  return `第 ${input.groupStart + input.currentIndex + 1} / ${total} 题`;
}

export type ReadingWrongbookSessionGroupResult = {
  group: WrongQuestionSessionGroup;
  payload: ReadingCorrectionResultPayload;
};

export type ReadingWrongbookSessionAnswer = {
  answerId: string;
  /** 1-based global order across the whole session. */
  globalOrder: number;
  groupIndex: number;
  isAnswered: boolean;
  isCorrect: boolean;
  /** 0-based global index; also the review page index. */
  reviewIndex: number;
};

/**
 * Merges the frozen session's per-source correction results into one
 * session-level result in the normal Reading result shape: chips are 1..N in
 * frozen session order, with no per-material sections.
 */
export function mergeReadingWrongbookSessionResults(
  groupResults: ReadingWrongbookSessionGroupResult[]
) {
  const answers: ReadingWrongbookSessionAnswer[] = [];
  let correctPoints = 0;
  let elapsedSeconds = 0;
  let totalPoints = 0;
  groupResults.forEach((entry, groupIndex) => {
    for (const answer of entry.payload.answers) {
      answers.push({
        answerId: answer.answerId,
        globalOrder: answers.length + 1,
        groupIndex,
        isAnswered: answer.isAnswered,
        isCorrect: answer.isCorrect,
        reviewIndex: answers.length
      });
    }
    correctPoints += entry.payload.attempt.correctPoints;
    elapsedSeconds += entry.payload.attempt.elapsedSeconds;
    totalPoints += entry.payload.attempt.totalPoints;
  });
  return { answers, correctPoints, elapsedSeconds, totalPoints };
}

export type ReadingWrongbookSessionReviewGroup = {
  group: WrongQuestionSessionGroup;
  payload: SubmittedReadingReviewPayload & {
    disclosures: Record<string, ReadingCorrectionAnswerPresentation>;
  };
};

export type ReadingWrongbookSessionReviewItem = ReadingFullSetReviewItem & {
  answerId: string;
  /** 1-based global order of this scoring point. */
  order: number;
  slotId: string | null;
  /** The source's review has not loaded yet; the position is reserved. */
  placeholder?: boolean;
};

export type ReadingWrongbookSessionReviewOccurrence = ReadingFullSetReviewOccurrence & {
  /** Correction attempt of this source (entry correction entry point). */
  attemptId: string;
  /** The source still has wrong / unanswered scoring points. */
  hasWrong: boolean;
};

export type ReadingWrongbookSessionReviewPayload = {
  attempt: { attemptId: string; title: string };
  disclosures: Record<string, ReadingCorrectionAnswerPresentation>;
  occurrences: ReadingWrongbookSessionReviewOccurrence[];
  reviewItems: ReadingWrongbookSessionReviewItem[];
};

/**
 * Global per-source item counts of a session review. RDL / RAP sources keep
 * exactly their drawn targets; a CTW source additionally shows its preserved
 * (previously answered) slots, so its count comes from the result page that
 * already loaded the same rows. `null` means "unknown": the caller then loads
 * every source before rendering instead of inventing positions.
 */
export type ReadingWrongbookSessionReviewShape = {
  logicalItemId: string;
  itemCount: number;
};

/**
 * Cache key (within the student wrong-question namespace) where the session
 * result page records the exact per-source item counts it just loaded, so the
 * read-only review can position every global question before its own per-source
 * requests return.
 */
export function readingWrongbookSessionShapeCacheKey(sessionId: string) {
  return `reading-bank-result-shape:${sessionId}`;
}

export function resolveReadingWrongbookSessionReviewShape(input: {
  cachedShape?: ReadingWrongbookSessionReviewShape[] | null;
  groups: WrongQuestionSessionGroup[];
  taskType: ReadingModule;
}): ReadingWrongbookSessionReviewShape[] | null {
  if (input.taskType !== "ctw") {
    return input.groups.map((group) => ({
      logicalItemId: group.logicalItemId,
      itemCount: group.targets.length
    }));
  }
  if (!input.cachedShape?.length) return null;
  const countById = new Map(input.cachedShape.map((entry) => [entry.logicalItemId, entry.itemCount]));
  const shape = input.groups.map((group) => ({
    logicalItemId: group.logicalItemId,
    itemCount: countById.get(group.logicalItemId) ?? -1
  }));
  return shape.every((entry) => entry.itemCount >= 0) ? shape : null;
}

/** 0-based source index that owns a global review index, or 0 when empty. */
export function findReadingWrongbookSessionShapeIndex(
  shape: ReadingWrongbookSessionReviewShape[],
  globalIndex: number
) {
  let offset = 0;
  for (let index = 0; index < shape.length; index += 1) {
    const count = Math.max(0, shape[index].itemCount);
    if (globalIndex < offset + count) return index;
    offset += count;
  }
  return Math.max(0, shape.length - 1);
}

function placeholderReviewItem(input: {
  globalIndex: number;
  href: string;
  logicalItemId: string;
  localIndex: number;
  taskType: ReadingModule;
}): ReadingWrongbookSessionReviewItem {
  return {
    answerId: `${input.logicalItemId}:placeholder:${input.localIndex}`,
    href: input.href,
    isAnswered: false,
    isCorrect: false,
    key: `placeholder:${input.logicalItemId}:${input.localIndex}`,
    moduleNumber: 1,
    occurrenceId: input.logicalItemId,
    order: input.globalIndex + 1,
    orderEnd: input.globalIndex + 1,
    orderStart: input.globalIndex + 1,
    placeholder: true,
    questionId: "",
    questionTimeSeconds: null,
    slotId: null,
    slotReviews: [],
    sourceAnswerIndex: input.globalIndex,
    taskType: input.taskType
  };
}

/**
 * Builds the multi-source read-only review payload for a finished session by
 * concatenating each source's existing submitted review in the frozen session
 * order. Global numbering continues across sources, and every item carries the
 * URL of its exact session review position.
 *
 * With `shapes` the payload is built eagerly for the whole session: sources
 * whose review has not loaded yet contribute exact-position placeholder items,
 * so the page can render (and number) immediately while a source loads on
 * demand. Without shapes the payload contains only the loaded sources.
 */
export function buildReadingWrongbookSessionReviewPayload(input: {
  groupReviews: ReadingWrongbookSessionReviewGroup[];
  reviewHref: (globalIndex: number) => string;
  sessionId: string;
  shapes?: ReadingWrongbookSessionReviewShape[] | null;
  taskType: ReadingModule;
  title: string;
}): ReadingWrongbookSessionReviewPayload {
  const occurrences: ReadingWrongbookSessionReviewOccurrence[] = [];
  const reviewItems: ReadingWrongbookSessionReviewItem[] = [];
  const disclosures: Record<string, ReadingCorrectionAnswerPresentation> = {};
  const reviewByItemId = new Map(
    input.groupReviews.map((entry) => [entry.group.logicalItemId, entry])
  );

  const appendLoadedGroup = (entry: ReadingWrongbookSessionReviewGroup) => {
    const { group, payload } = entry;
    occurrences.push({
      answers: payload.answers,
      attemptId: payload.attempt.attemptId,
      hasWrong: payload.reviewItems.some((item) => !item.isAnswered || !item.isCorrect),
      moduleNumber: 1,
      occurrenceId: group.logicalItemId,
      practice: payload.practice
    });
    Object.assign(disclosures, payload.disclosures);
    const items: SubmittedReadingReviewItem[] = payload.reviewItems;
    const groupStart = reviewItems.length;
    items.forEach((item, itemIndex) => {
      const globalIndex = groupStart + itemIndex;
      const slotReviews = items
        .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
        .filter(({ candidate }) => candidate.questionId === item.questionId)
        .map(({ candidate, candidateIndex }): ReadingFullSetResultAnswer => ({
          answerId: candidate.answerId,
          index: groupStart + candidateIndex,
          isAnswered: candidate.isAnswered,
          isCorrect: candidate.isCorrect,
          logicalItemId: group.logicalItemId,
          moduleNumber: 1,
          occurrenceId: group.logicalItemId,
          order: groupStart + candidateIndex + 1,
          questionId: candidate.questionId,
          questionTimeSeconds: candidate.questionTimeSeconds,
          slotId: candidate.slotId,
          taskType: input.taskType
        }));
      reviewItems.push({
        answerId: item.answerId,
        href: input.reviewHref(globalIndex),
        isAnswered: item.isAnswered,
        isCorrect: item.isCorrect,
        key: `${group.logicalItemId}:${item.answerId}`,
        moduleNumber: 1,
        occurrenceId: group.logicalItemId,
        order: globalIndex + 1,
        orderEnd: globalIndex + 1,
        orderStart: globalIndex + 1,
        questionId: item.questionId,
        questionTimeSeconds: item.questionTimeSeconds,
        slotId: item.slotId,
        slotReviews,
        sourceAnswerIndex: globalIndex,
        taskType: input.taskType
      });
    });
  };

  if (input.shapes?.length) {
    for (const shape of input.shapes) {
      const loaded = reviewByItemId.get(shape.logicalItemId);
      if (loaded) {
        appendLoadedGroup(loaded);
        continue;
      }
      for (let localIndex = 0; localIndex < Math.max(0, shape.itemCount); localIndex += 1) {
        const globalIndex = reviewItems.length;
        reviewItems.push(placeholderReviewItem({
          globalIndex,
          href: input.reviewHref(globalIndex),
          logicalItemId: shape.logicalItemId,
          localIndex,
          taskType: input.taskType
        }));
      }
    }
  } else {
    for (const entry of input.groupReviews) appendLoadedGroup(entry);
  }

  return {
    attempt: { attemptId: input.sessionId, title: input.title },
    disclosures,
    occurrences,
    reviewItems
  };
}
