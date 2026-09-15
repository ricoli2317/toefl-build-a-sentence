import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildReadingCorrectionAnswerPresentations,
  type ReadingCorrectionAnchorRow,
  type ReadingCorrectionAnswerPresentation,
  type ReadingCorrectionCtwSlotRow,
  type ReadingCorrectionOptionRow,
  type ReadingCorrectionQuestionRow,
  type ReadingCorrectionSentenceRow
} from "./correctionResult";
import type { ReadingAnswerRow } from "./history";

export type ReadingDisclosureAnswerRow = Pick<
  ReadingAnswerRow,
  "attempt_answer_id" | "answer_kind" | "question_id" | "slot_id" | "student_answer"
> & Partial<Pick<ReadingAnswerRow, "is_correct" | "question_time_seconds">>;

/**
 * Loads the answer labels and correct-answer markers used by every submitted
 * Reading review. Callers must verify ownership and submitted/completed status
 * before invoking this service-role helper.
 */
export async function loadReadingAnswerDisclosures(
  db: SupabaseClient,
  rows: ReadingDisclosureAnswerRow[]
): Promise<Record<string, ReadingCorrectionAnswerPresentation>> {
  const questionIds = Array.from(new Set(rows.map((row) => row.question_id)));
  if (questionIds.length === 0) return {};

  const [questionResult, slotResult, optionResult, anchorResult] = await Promise.all([
    db.from("reading_questions")
      .select("question_id,question_type,correct_option_id,correct_anchor_id,correct_sentence_id")
      .in("question_id", questionIds),
    db.from("reading_ctw_slots")
      .select("question_id,slot_id,prefix,answer,display_text,missing_text")
      .in("question_id", questionIds),
    db.from("reading_question_options")
      .select("question_id,option_id,option_order,option_text")
      .in("question_id", questionIds),
    db.from("reading_rap_insertion_anchors")
      .select("question_id,anchor_id,anchor_order")
      .in("question_id", questionIds)
  ]);
  const baseError = questionResult.error ?? slotResult.error ?? optionResult.error ?? anchorResult.error;
  if (baseError) throw new Error(baseError.message);

  const questions = (questionResult.data ?? []) as ReadingCorrectionQuestionRow[];
  const sentenceIds = Array.from(new Set([
    ...questions.map((question) => question.correct_sentence_id),
    ...rows
      .filter((row) => row.answer_kind === "sentence_selection")
      .map((row) => row.student_answer)
  ].filter((value): value is string => Boolean(value))));
  const sentenceResult = sentenceIds.length
    ? await db.from("reading_passage_sentences")
        .select("sentence_id,sentence_order,sentence_text")
        .in("sentence_id", sentenceIds)
    : { data: [], error: null };
  if (sentenceResult.error) throw new Error(sentenceResult.error.message);

  return buildReadingCorrectionAnswerPresentations({
    anchors: (anchorResult.data ?? []) as ReadingCorrectionAnchorRow[],
    correctionRows: rows as ReadingAnswerRow[],
    ctwSlots: (slotResult.data ?? []) as ReadingCorrectionCtwSlotRow[],
    options: (optionResult.data ?? []) as ReadingCorrectionOptionRow[],
    questions,
    sentences: (sentenceResult.data ?? []) as ReadingCorrectionSentenceRow[]
  });
}
