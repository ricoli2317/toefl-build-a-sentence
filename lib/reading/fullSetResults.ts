import { READING_PRODUCT_NAMES } from "./product.ts";
import type {
  ReadingFullSet,
  ReadingFullSetOccurrence,
  ReadingFullSetRdlLength
} from "./fullSets.ts";
import type { ReadingModule } from "./types.ts";

export type ReadingFullSetOccurrenceScore = {
  occurrenceId: string;
  correctPoints: number;
};

export type ReadingFullSetScoreRange = {
  rawMin: number;
  rawMax: number;
  scaledMin: number;
  scaledMax: number;
  display: string;
  breakdown: {
    ctwMin: number;
    ctwMax: number;
    rdlMin: number;
    rdlMax: number;
    rapMin: number;
    rapMax: number;
    module2Correct: number;
    rdlGrouping: "single_group" | "unpaired_legal_combinations";
  };
};

export type ReadingFullSetResultAnswer = {
  answerId: string;
  index: number;
  moduleNumber: 1 | 2;
  taskType: ReadingModule;
  occurrenceId: string;
  logicalItemId: string;
  order: number;
  questionId: string;
  slotId: string | null;
  isAnswered: boolean;
  isCorrect: boolean;
  questionTimeSeconds: number | null;
};

export type ReadingFullSetResultSection = {
  taskType: ReadingModule;
  taskName: string;
  answers: ReadingFullSetResultAnswer[];
};

export type ReadingFullSetResultModule = {
  moduleNumber: 1 | 2;
  sections: ReadingFullSetResultSection[];
};

export type ReadingFullSetResultPayload = {
  attempt: {
    attemptId: string;
    fullSetId: string;
    title: string;
    completedAt: string;
  };
  score: ReadingFullSetScoreRange;
  modules: ReadingFullSetResultModule[];
  answers: ReadingFullSetResultAnswer[];
};

export type ReadingFullSetResultAnswerRow = {
  answer_id: string;
  module_attempt_id: string;
  occurrence_id: string;
  logical_item_id: string;
  question_id: string;
  slot_id: string | null;
  student_answer: string | null;
  is_correct: boolean | null;
  question_time_seconds: number | null;
};

export type ReadingFullSetResultQuestionRow = {
  question_id: string;
  question_order: number;
};

export type ReadingFullSetResultSlotRow = {
  question_id: string;
  slot_id: string;
  slot_order: number;
};

export type ReadingFullSetResultModuleRow = {
  module_attempt_id: string;
  module_number: number;
};

const RAW_TO_SCALED = [
  1, 1, 1, 1, 1, 1, 2, 2.5, 3, 3, 3, 3,
  3.5, 3.5, 3.5, 3.5, 3.5, 3.5,
  4, 4, 4, 4, 4, 4, 4,
  4.5, 4.5, 4.5,
  5, 5, 5, 5,
  5.5, 5.5,
  6, 6
] as const;

export function readingRawToScaled(raw: number) {
  if (!Number.isInteger(raw) || raw < 0 || raw > 35) {
    throw new Error("READING_FULL_SET_RAW_SCORE_OUT_OF_RANGE");
  }
  return RAW_TO_SCALED[raw];
}

export function calculateReadingFullSetScoreRange(
  fullSet: ReadingFullSet,
  scores: ReadingFullSetOccurrenceScore[]
): ReadingFullSetScoreRange {
  if (!fullSet.validation.valid) throw new Error("READING_FULL_SET_INVALID");
  const scoreByOccurrence = new Map(scores.map((score) => [
    score.occurrenceId,
    nonNegativeInteger(score.correctPoints)
  ]));
  const correct = (occurrence: ReadingFullSetOccurrence) => {
    const value = scoreByOccurrence.get(occurrence.occurrenceId);
    if (value === undefined || value > occurrence.scoringPointCount) {
      throw new Error("READING_FULL_SET_OCCURRENCE_SCORE_INVALID");
    }
    return value;
  };

  const m1 = fullSet.module1.occurrences;
  const ctw = m1.filter((item) => item.taskType === "ctw").map(correct);
  const rap = m1.filter((item) => item.taskType === "rap").map(correct);
  const shortRdl = rdlScores(m1, "short", correct);
  const longRdl = rdlScores(m1, "long", correct);
  const module2Correct = fullSet.module2.occurrences.reduce(
    (sum, occurrence) => sum + correct(occurrence),
    0
  );
  if (ctw.length !== 2 || (rap.length !== 1 && rap.length !== 2)) {
    throw new Error("READING_FULL_SET_M1_SCORE_SHAPE_INVALID");
  }

  const ctwMin = Math.min(...ctw);
  const ctwMax = Math.max(...ctw);
  const rapMin = Math.min(...rap);
  const rapMax = Math.max(...rap);
  const singleRdlGroup = shortRdl.length === 1 && longRdl.length === 1;
  if (!singleRdlGroup && (shortRdl.length !== 2 || longRdl.length !== 2)) {
    throw new Error("READING_FULL_SET_RDL_SCORE_SHAPE_INVALID");
  }

  // Source metadata has no durable RDL group identifier. For two short and two
  // long occurrences, use all legal one-short + one-long combinations instead
  // of inferring a pairing from adjacency or array indexes.
  const rdlMin = Math.min(...shortRdl) + Math.min(...longRdl);
  const rdlMax = Math.max(...shortRdl) + Math.max(...longRdl);
  const rawMin = ctwMin + rdlMin + rapMin + module2Correct;
  const rawMax = ctwMax + rdlMax + rapMax + module2Correct;
  if (rawMin < 0 || rawMin > rawMax || rawMax > 35) {
    throw new Error("READING_FULL_SET_SCORE_RANGE_INVALID");
  }
  const scaledMin = readingRawToScaled(rawMin);
  const scaledMax = readingRawToScaled(rawMax);
  return {
    rawMin,
    rawMax,
    scaledMin,
    scaledMax,
    display: scaledMin === scaledMax ? String(scaledMin) : `${scaledMin} - ${scaledMax}`,
    breakdown: {
      ctwMin,
      ctwMax,
      rdlMin,
      rdlMax,
      rapMin,
      rapMax,
      module2Correct,
      rdlGrouping: singleRdlGroup ? "single_group" : "unpaired_legal_combinations"
    }
  };
}

export function buildReadingFullSetResultPayload(input: {
  attempt: { attempt_id: string; full_set_id: string; completed_at: string };
  fullSet: ReadingFullSet;
  modules: ReadingFullSetResultModuleRow[];
  answers: ReadingFullSetResultAnswerRow[];
  questions: ReadingFullSetResultQuestionRow[];
  slots: ReadingFullSetResultSlotRow[];
}): ReadingFullSetResultPayload {
  const moduleById = new Map(input.modules.map((module) => [
    module.module_attempt_id,
    module.module_number === 1 ? 1 as const : 2 as const
  ]));
  const questionOrder = new Map(input.questions.map((question) => [question.question_id, question.question_order]));
  const slotOrder = new Map(input.slots.map((slot) => [`${slot.question_id}:${slot.slot_id}`, slot.slot_order]));
  const occurrenceById = new Map([
    ...input.fullSet.module1.occurrences,
    ...input.fullSet.module2.occurrences
  ].map((occurrence) => [occurrence.occurrenceId, occurrence]));

  const ordered = input.answers.map((row) => {
    const occurrence = occurrenceById.get(row.occurrence_id);
    const moduleNumber = moduleById.get(row.module_attempt_id);
    if (!occurrence || !moduleNumber) throw new Error("READING_FULL_SET_RESULT_RELATION_MISSING");
    const localOrder = row.slot_id
      ? slotOrder.get(`${row.question_id}:${row.slot_id}`)
      : questionOrder.get(row.question_id);
    if (!localOrder) throw new Error("READING_FULL_SET_RESULT_ORDER_MISSING");
    return {
      answerId: row.answer_id,
      index: -1,
      moduleNumber,
      taskType: occurrence.taskType,
      occurrenceId: occurrence.occurrenceId,
      logicalItemId: occurrence.logicalItemId,
      order: occurrence.sourceQuestionStart + localOrder - 1,
      questionId: row.question_id,
      slotId: row.slot_id,
      isAnswered: Boolean(row.student_answer?.trim()),
      isCorrect: row.is_correct === true,
      questionTimeSeconds: row.question_time_seconds
    } satisfies ReadingFullSetResultAnswer;
  }).sort((left, right) =>
    left.moduleNumber - right.moduleNumber
    || left.order - right.order
    || left.answerId.localeCompare(right.answerId)
  ).map((answer, index) => ({ ...answer, index }));

  if (ordered.length !== 50) throw new Error("READING_FULL_SET_RESULT_ANSWER_COUNT_MISMATCH");
  const occurrenceScores = Array.from(occurrenceById.values()).map((occurrence) => ({
    occurrenceId: occurrence.occurrenceId,
    correctPoints: ordered.filter((answer) =>
      answer.occurrenceId === occurrence.occurrenceId && answer.isCorrect
    ).length
  }));

  return {
    attempt: {
      attemptId: input.attempt.attempt_id,
      fullSetId: input.attempt.full_set_id,
      title: input.fullSet.title ?? input.attempt.full_set_id,
      completedAt: input.attempt.completed_at
    },
    score: calculateReadingFullSetScoreRange(input.fullSet, occurrenceScores),
    modules: ([1, 2] as const).map((moduleNumber) => ({
      moduleNumber,
      sections: (["ctw", "rdl", "rap"] as const).flatMap((taskType) => {
        const answers = ordered.filter((answer) =>
          answer.moduleNumber === moduleNumber && answer.taskType === taskType
        );
        return answers.length ? [{ taskType, taskName: READING_PRODUCT_NAMES[taskType], answers }] : [];
      })
    })),
    answers: ordered
  };
}

function rdlScores(
  occurrences: ReadingFullSetOccurrence[],
  length: ReadingFullSetRdlLength,
  correct: (occurrence: ReadingFullSetOccurrence) => number
) {
  return occurrences.filter((item) => item.taskType === "rdl" && item.rdlLength === length).map(correct);
}

function nonNegativeInteger(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
