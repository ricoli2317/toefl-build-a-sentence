import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dedupeGrammarQuestions,
  questionHasGrammarTag,
  shuffleQuestions,
  type GrammarQuestionRow
} from "./grammarPractice.ts";
import { readAllSupabaseRows } from "./supabasePagination.ts";

const GRAMMAR_QUESTION_COLUMNS =
  "question_id,set_id,set_title,question_order,prompt,sentence_template,blank_count,options_text,distractors_text,final_sentence,grammar_tags_text";

/**
 * Server-only BAS Grammar question pool. The ordinary preview GET and the
 * persisted random Start both use this exact loader and normalization so a
 * frozen manifest contains the same public question shape shown in practice.
 */
export async function loadGrammarQuestionPool(
  db: SupabaseClient
): Promise<GrammarQuestionRow[]> {
  const result = await readAllSupabaseRows<GrammarQuestionRow>((from, to) =>
    db
      .from("questions")
      .select(GRAMMAR_QUESTION_COLUMNS)
      .order("set_id", { ascending: true })
      .order("question_order", { ascending: true })
      .order("question_id", { ascending: true })
      .range(from, to)
  );
  if (result.error) {
    throw new Error(`Failed to load grammar questions: ${result.error.message}`);
  }
  return (result.data ?? []).map(normalizeGrammarQuestion);
}

export function selectGrammarPracticeQuestions(
  questions: GrammarQuestionRow[],
  selectedTag: string,
  mode: "all" | "random"
) {
  const deduped = dedupeGrammarQuestions(
    questions.filter((question) => questionHasGrammarTag(question, selectedTag))
  );
  return mode === "random"
    ? shuffleQuestions(deduped).slice(0, 10)
    : deduped;
}

export function drawGrammarPracticeQuestions(
  questions: GrammarQuestionRow[],
  selectedTag: string
) {
  return selectGrammarPracticeQuestions(questions, selectedTag, "random");
}

export function normalizeGrammarQuestion(
  question: GrammarQuestionRow
): GrammarQuestionRow {
  return {
    blank_count: question.blank_count ?? 0,
    distractors_text: question.distractors_text ?? "",
    final_sentence: question.final_sentence ?? "",
    grammar_tags_text: question.grammar_tags_text ?? "",
    options_text: question.options_text ?? "",
    prompt: question.prompt ?? "",
    question_id: String(question.question_id),
    question_order: question.question_order ?? 0,
    sentence_template: question.sentence_template ?? "",
    set_id: String(question.set_id),
    set_title: question.set_title ?? String(question.set_id)
  };
}

export function toPublicGrammarQuestion({
  final_sentence: _finalSentence,
  ...question
}: GrammarQuestionRow) {
  return question;
}
