import { READING_PRODUCT_NAMES } from "./product.ts";
import type { ReadingModule } from "./types.ts";

export type ReadingHistoryAttempt = {
  attemptId: string;
  logicalItemId: string;
  taskType: ReadingModule;
  taskName: string;
  itemTitle: string;
  correctPoints: number;
  totalPoints: number;
  accuracy: number;
  elapsedSeconds: number;
  submittedAt: string;
};

export type ReadingHistoryPayload = { attempts: ReadingHistoryAttempt[] };

export type ReadingResultAnswer = {
  answerId: string;
  order: number;
  isAnswered: boolean;
  isCorrect: boolean;
  questionId: string;
  questionTimeSeconds: number | null;
};

export type ReadingResultCtwSegment =
  | { kind: "text"; text: string }
  | {
      kind: "blank";
      answerId: string;
      isAnswered: boolean;
      isCorrect: boolean;
      order: number;
      prefix: string;
      studentAnswer: string;
    };

export type ReadingResultCtwParagraph = {
  paragraphId: string;
  paragraphOrder: number;
  segments: ReadingResultCtwSegment[];
};

export type ReadingResultPayload = {
  attempt: ReadingHistoryAttempt;
  answers: ReadingResultAnswer[];
  ctwParagraphs: ReadingResultCtwParagraph[];
};

export type ReadingAttemptRow = {
  attempt_id: string;
  logical_item_id: string;
  task_type: ReadingModule;
  elapsed_seconds: number;
  submitted_at: string | null;
  total_points: number;
  correct_points: number;
};

export type ReadingItemRow = {
  logical_item_id: string;
  module: ReadingModule;
  title: string | null;
};

export type ReadingAnswerRow = {
  attempt_answer_id: string;
  question_id: string;
  slot_id: string | null;
  answer_kind: "ctw_slot" | "option" | "insertion_anchor" | "sentence_selection";
  student_answer: string | null;
  is_correct: boolean;
  question_time_seconds: number | null;
};

export type ReadingQuestionResultRow = {
  question_id: string;
  question_order: number;
  question_type: string;
};

export type ReadingCtwParagraphResultRow = {
  question_id: string;
  paragraph_id: string;
  paragraph_order: number;
};

export type ReadingCtwSegmentResultRow = {
  question_id: string;
  paragraph_id: string;
  segment_order: number;
  segment_type: "text" | "blank";
  text_content: string | null;
  slot_id: string | null;
};

export type ReadingSlotResultRow = {
  question_id: string;
  slot_id: string;
  slot_order: number;
  prefix: string;
};

export function buildReadingHistoryPayload(
  attempts: ReadingAttemptRow[],
  items: ReadingItemRow[]
): ReadingHistoryPayload {
  const itemById = new Map(items.map((item) => [item.logical_item_id, item]));
  return {
    attempts: attempts
      .filter((attempt): attempt is ReadingAttemptRow & { submitted_at: string } => Boolean(attempt.submitted_at))
      .map((attempt) => toHistoryAttempt(attempt, itemById.get(attempt.logical_item_id)))
      .sort((left, right) =>
        Date.parse(right.submittedAt) - Date.parse(left.submittedAt)
        || right.attemptId.localeCompare(left.attemptId)
      )
  };
}

export function buildReadingResultPayload(input: {
  attempt: ReadingAttemptRow & { submitted_at: string };
  item: ReadingItemRow;
  answers: ReadingAnswerRow[];
  questions: ReadingQuestionResultRow[];
  ctwParagraphs?: ReadingCtwParagraphResultRow[];
  ctwSegments?: ReadingCtwSegmentResultRow[];
  slots?: ReadingSlotResultRow[];
}): ReadingResultPayload {
  const questionById = new Map(input.questions.map((question) => [question.question_id, question]));
  const slotById = new Map((input.slots ?? []).map((slot) => [`${slot.question_id}:${slot.slot_id}`, slot]));
  const answerBySlot = new Map(input.answers
    .filter((answer) => answer.answer_kind === "ctw_slot" && answer.slot_id)
    .map((answer) => [`${answer.question_id}:${answer.slot_id}`, answer]));

  const answers = input.answers.map((answer): ReadingResultAnswer => {
    const question = questionById.get(answer.question_id);
    if (!question) throw new Error("READING_RESULT_QUESTION_MISSING");
    const slot = answer.answer_kind === "ctw_slot"
      ? slotById.get(`${answer.question_id}:${answer.slot_id ?? ""}`)
      : null;
    if (answer.answer_kind === "ctw_slot" && !slot) {
      throw new Error("READING_RESULT_SLOT_MISSING");
    }
    return {
      answerId: answer.attempt_answer_id,
      order: slot?.slot_order ?? question.question_order,
      isAnswered: emptyToNull(answer.student_answer) !== null,
      isCorrect: answer.is_correct,
      questionId: answer.question_id,
      questionTimeSeconds: answer.question_time_seconds ?? null
    };
  }).sort((left, right) => left.order - right.order || left.answerId.localeCompare(right.answerId));

  if (answers.length !== input.attempt.total_points) {
    throw new Error("READING_RESULT_ANSWER_COUNT_MISMATCH");
  }

  const ctwParagraphs = (input.ctwParagraphs ?? [])
    .map((paragraph): ReadingResultCtwParagraph => ({
      paragraphId: paragraph.paragraph_id,
      paragraphOrder: paragraph.paragraph_order,
      segments: (input.ctwSegments ?? [])
        .filter((segment) =>
          segment.question_id === paragraph.question_id
          && segment.paragraph_id === paragraph.paragraph_id
        )
        .sort((left, right) => left.segment_order - right.segment_order)
        .map((segment): ReadingResultCtwSegment => {
          if (segment.segment_type === "text") {
            return { kind: "text", text: segment.text_content ?? "" };
          }
          const slot = segment.slot_id
            ? slotById.get(`${segment.question_id}:${segment.slot_id}`)
            : null;
          const answer = segment.slot_id
            ? answerBySlot.get(`${segment.question_id}:${segment.slot_id}`)
            : null;
          if (!slot || !answer) throw new Error("READING_RESULT_CTW_SEGMENT_MISSING");
          const studentAnswer = emptyToNull(answer.student_answer) ?? "";
          return {
            kind: "blank",
            answerId: answer.attempt_answer_id,
            isAnswered: Boolean(studentAnswer),
            isCorrect: answer.is_correct,
            order: slot.slot_order,
            prefix: slot.prefix,
            studentAnswer
          };
        })
    }))
    .sort((left, right) => left.paragraphOrder - right.paragraphOrder);

  if (input.attempt.task_type === "ctw" && ctwParagraphs.length === 0) {
    throw new Error("READING_RESULT_CTW_PARAGRAPHS_MISSING");
  }

  return {
    attempt: toHistoryAttempt(input.attempt, input.item),
    answers,
    ctwParagraphs
  };
}

function toHistoryAttempt(
  attempt: ReadingAttemptRow & { submitted_at: string },
  item?: ReadingItemRow
): ReadingHistoryAttempt {
  const totalPoints = Math.max(0, attempt.total_points);
  return {
    attemptId: attempt.attempt_id,
    logicalItemId: attempt.logical_item_id,
    taskType: attempt.task_type,
    taskName: READING_PRODUCT_NAMES[attempt.task_type],
    itemTitle: safeReadingItemTitle(attempt.task_type, item?.title),
    correctPoints: attempt.correct_points,
    totalPoints,
    accuracy: totalPoints > 0 ? attempt.correct_points / totalPoints : 0,
    elapsedSeconds: attempt.elapsed_seconds,
    submittedAt: attempt.submitted_at
  };
}

export function safeReadingItemTitle(module: ReadingModule, title: string | null | undefined) {
  const normalized = title?.trim();
  return normalized || READING_PRODUCT_NAMES[module];
}

function emptyToNull(value: string | null) {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}
