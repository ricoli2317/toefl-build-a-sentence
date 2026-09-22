import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildReadingAnswerKeyPresentations,
  type ReadingCorrectionAnchorRow,
  type ReadingCorrectionAnswerPresentation,
  type ReadingCorrectionCtwSlotRow,
  type ReadingCorrectionOptionRow,
  type ReadingCorrectionQuestionRow,
  type ReadingCorrectionSentenceRow
} from "./reading/correctionResult.ts";
import type { ReadingAnswer } from "./reading/practiceState.ts";
import type { StudentReadingPracticePayload } from "./reading/studentPractice.ts";
import type {
  TeacherReadingBankAnswerKey,
  TeacherReadingBankAnswerKeyEntry
} from "./teacherReadingQuestionBank.ts";

type CtwSlotRow = ReadingCorrectionCtwSlotRow & { slot_order: number };

/**
 * Builds the teacher question-bank answer key from the canonical Reading
 * question tables. Only public question content, options, slots, anchors, and
 * sentences are read; student attempts and answers are never involved.
 */
export async function buildTeacherReadingAnswerKey(
  db: SupabaseClient,
  practice: StudentReadingPracticePayload
): Promise<TeacherReadingBankAnswerKey | null> {
  const questionIds = practice.questions.map((question) => question.questionId);
  if (questionIds.length === 0) return null;

  const questionResult = await db
    .from("reading_questions")
    .select(
      "question_id,question_order,question_type,correct_option_id,correct_anchor_id,correct_sentence_id"
    )
    .in("question_id", questionIds)
    .order("question_order", { ascending: true });
  if (questionResult.error) throw new Error(questionResult.error.message);
  const questions = (questionResult.data ?? []) as ReadingCorrectionQuestionRow[];
  if (questions.length === 0) return null;

  const isCtw = practice.item.module === "ctw";
  const [options, ctwSlots, anchors, sentences] = await Promise.all([
    isCtw ? Promise.resolve<ReadingCorrectionOptionRow[]>([]) : loadOptions(db, questionIds),
    isCtw ? loadCtwSlots(db, questionIds) : Promise.resolve<CtwSlotRow[]>([]),
    practice.item.module === "rap"
      ? loadAnchors(db, questionIds)
      : Promise.resolve<ReadingCorrectionAnchorRow[]>([]),
    practice.passage
      ? loadSentences(db, practice.passage.passageId)
      : Promise.resolve<ReadingCorrectionSentenceRow[]>([])
  ]);

  const presentations = buildReadingAnswerKeyPresentations({
    questions,
    options,
    ctwSlots,
    anchors,
    sentences
  });

  const entries: TeacherReadingBankAnswerKeyEntry[] = [];
  for (const question of questions) {
    if (question.question_type === "ctw") {
      for (const slot of ctwSlots) {
        if (slot.question_id !== question.question_id) continue;
        const answerId = `${slot.question_id}:${slot.slot_id}`;
        entries.push({
          answerId,
          questionId: question.question_id,
          slotId: slot.slot_id,
          order: Number(slot.slot_order),
          answer: null,
          ctwCharacters: ctwCharactersFromPresentation(presentations[answerId])
        });
      }
      continue;
    }
    const answer = answerKeyAnswer(question);
    if (!answer) continue;
    entries.push({
      answerId: question.question_id,
      questionId: question.question_id,
      slotId: null,
      order: Number(question.question_order),
      answer,
      ctwCharacters: null
    });
  }

  return { entries, presentations };
}

function answerKeyAnswer(question: ReadingCorrectionQuestionRow): ReadingAnswer | null {
  if (question.question_type === "rdl" || question.question_type === "rap_multiple_choice") {
    return question.correct_option_id
      ? { kind: "choice", optionId: question.correct_option_id }
      : null;
  }
  if (question.question_type === "rap_sentence_insertion") {
    return question.correct_anchor_id
      ? { kind: "insertion", anchorId: question.correct_anchor_id }
      : null;
  }
  if (question.question_type === "rap_sentence_selection") {
    return question.correct_sentence_id
      ? { kind: "sentence_selection", sentenceId: question.correct_sentence_id }
      : null;
  }
  return null;
}

function ctwCharactersFromPresentation(
  presentation: ReadingCorrectionAnswerPresentation | undefined
) {
  if (!presentation || presentation.correctAnswer.kind !== "ctw_word") return null;
  const missing = presentation.correctAnswer.parts
    .filter((part) => part.emphasized)
    .map((part) => part.text)
    .join("");
  return Array.from(missing);
}

async function loadOptions(db: SupabaseClient, questionIds: string[]) {
  const result = await db
    .from("reading_question_options")
    .select("question_id,option_id,option_order,option_text")
    .in("question_id", questionIds)
    .order("option_order", { ascending: true });
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []) as ReadingCorrectionOptionRow[];
}

async function loadCtwSlots(db: SupabaseClient, questionIds: string[]) {
  const result = await db
    .from("reading_ctw_slots")
    .select("question_id,slot_id,slot_order,answer,display_text,missing_text,prefix")
    .in("question_id", questionIds)
    .order("slot_order", { ascending: true });
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []) as CtwSlotRow[];
}

async function loadAnchors(db: SupabaseClient, questionIds: string[]) {
  const result = await db
    .from("reading_rap_insertion_anchors")
    .select("question_id,anchor_id,anchor_order")
    .in("question_id", questionIds)
    .order("anchor_order", { ascending: true });
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []) as ReadingCorrectionAnchorRow[];
}

async function loadSentences(db: SupabaseClient, passageId: string) {
  const result = await db
    .from("reading_passage_sentences")
    .select("sentence_id,sentence_order,sentence_text")
    .eq("passage_id", passageId)
    .order("sentence_order", { ascending: true });
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []) as ReadingCorrectionSentenceRow[];
}
