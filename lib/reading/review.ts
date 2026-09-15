import type { ReadingAttemptSummary } from "./attempts.ts";
import type { ReadingAnswerState } from "./practiceState.ts";
import type { StudentReadingPracticePayload } from "./studentPractice.ts";
import type { ReadingCorrectionAnswerPresentation } from "./correctionResult.ts";

export type SubmittedReadingAnswerRow = {
  attempt_answer_id?: string;
  answer_kind: "ctw_slot" | "option" | "insertion_anchor" | "sentence_selection";
  question_id: string;
  slot_id: string | null;
  student_answer: string | null;
  is_correct?: boolean;
  question_time_seconds?: number | null;
};

export type SubmittedReadingReviewItem = {
  answerId: string;
  order: number;
  isAnswered: boolean;
  isCorrect: boolean;
  questionId: string;
  slotId: string | null;
  questionTimeSeconds: number | null;
  href?: string;
};

export type SubmittedReadingReviewPayload = {
  answers: ReadingAnswerState;
  attempt: ReadingAttemptSummary;
  disclosures: Record<string, ReadingCorrectionAnswerPresentation>;
  practice: StudentReadingPracticePayload;
  reviewItems: SubmittedReadingReviewItem[];
};

export function buildSubmittedReadingReviewItems(
  practice: StudentReadingPracticePayload,
  rows: SubmittedReadingAnswerRow[]
): SubmittedReadingReviewItem[] {
  const questionOrder = new Map(practice.questions.map((question, index) => [
    question.questionId,
    "questionOrder" in question && Number.isInteger(question.questionOrder)
      ? Number(question.questionOrder)
      : index + 1
  ]));
  const slotOrder = new Map(practice.questions.flatMap((question) =>
    question.questionType === "ctw"
      ? question.slots.map((slot) => [`${question.questionId}:${slot.slotId}`, slot.slotOrder] as const)
      : []
  ));
  return rows.map((row, index) => ({
    answerId: row.attempt_answer_id ?? `${row.question_id}:${row.slot_id ?? ""}:${index}`,
    order: row.slot_id
      ? slotOrder.get(`${row.question_id}:${row.slot_id}`) ?? index + 1
      : questionOrder.get(row.question_id) ?? index + 1,
    isAnswered: Boolean(row.student_answer?.trim()),
    isCorrect: row.is_correct === true,
    questionId: row.question_id,
    slotId: row.slot_id,
    questionTimeSeconds: row.question_time_seconds ?? null
  })).sort((left, right) => left.order - right.order || left.answerId.localeCompare(right.answerId));
}

export function buildSubmittedReadingAnswerState(
  practice: StudentReadingPracticePayload,
  rows: SubmittedReadingAnswerRow[]
): ReadingAnswerState {
  const rowsByQuestion = new Map<string, SubmittedReadingAnswerRow[]>();
  for (const row of rows) {
    const current = rowsByQuestion.get(row.question_id) ?? [];
    current.push(row);
    rowsByQuestion.set(row.question_id, current);
  }

  const answers: ReadingAnswerState = {};
  for (const question of practice.questions) {
    const questionRows = rowsByQuestion.get(question.questionId) ?? [];
    if (question.questionType === "ctw") {
      const rowBySlot = new Map(questionRows.map((row) => [row.slot_id, row]));
      const slots = Object.fromEntries(question.slots.map((slot) => {
        const row = rowBySlot.get(slot.slotId);
        if (!row || row.answer_kind !== "ctw_slot") throw new Error("READING_REVIEW_CTW_ANSWER_MISSING");
        const characters = Array.from(row.student_answer ?? "").slice(0, slot.missingLength);
        return [slot.slotId, [
          ...characters,
          ...Array.from({ length: Math.max(0, slot.missingLength - characters.length) }, () => "")
        ]];
      }));
      answers[question.questionId] = { kind: "ctw", slots };
      continue;
    }

    if (questionRows.length !== 1) throw new Error("READING_REVIEW_QUESTION_ANSWER_MISSING");
    const row = questionRows[0];
    if (!row.student_answer) continue;
    if (question.questionType === "rap_sentence_insertion") {
      if (row.answer_kind !== "insertion_anchor" || !question.anchors.some((anchor) => anchor.anchorId === row.student_answer)) {
        throw new Error("READING_REVIEW_INSERTION_ANSWER_INVALID");
      }
      answers[question.questionId] = { kind: "insertion", anchorId: row.student_answer };
      continue;
    }
    if (question.questionType === "rap_sentence_selection") {
      const validSentence = practice.passage?.paragraphs.some((paragraph) =>
        paragraph.paragraphId === question.targetParagraphId
        && paragraph.sentences.some((sentence) => sentence.sentenceId === row.student_answer)
      );
      if (row.answer_kind !== "sentence_selection" || !validSentence) {
        throw new Error("READING_REVIEW_SENTENCE_ANSWER_INVALID");
      }
      answers[question.questionId] = { kind: "sentence_selection", sentenceId: row.student_answer };
      continue;
    }
    if (row.answer_kind !== "option" || !question.options.some((option) => option.optionId === row.student_answer)) {
      throw new Error("READING_REVIEW_OPTION_ANSWER_INVALID");
    }
    answers[question.questionId] = { kind: "choice", optionId: row.student_answer };
  }

  return answers;
}
