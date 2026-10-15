import { normalizeReviewSpelling } from "../lexical/wordbookReviewLocal.ts";

export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export const VOCABULARY_POS = ["noun", "verb", "adjective", "adverb", "preposition", "determiner",
  "pronoun", "conjunction", "particle", "numeral"] as const;
export const IRREGULAR_FORM_TYPES = ["past", "past_participle", "plural", "comparative", "superlative",
  "present_third_person_singular", "present_first_person_singular", "present_second_person_or_plural",
  "past_first_or_third_person_singular", "past_second_person_or_plural", "past_modal"] as const;

export type Cefr = typeof CEFR_LEVELS[number];
export type IrregularFormType = typeof IRREGULAR_FORM_TYPES[number];
export type SpellingMode = "base_form" | "irregular";
export type VocabularySense = { pos: typeof VOCABULARY_POS[number]; meaning_zh: string; example_en: string };
export type IrregularForm = { form_type: IrregularFormType; answers: string[] };
export type ReviewedVocabulary = { word: string; list_id: string; cefr: Cefr;
  senses: VocabularySense[]; irregular_forms: IrregularForm[] };
export type VocabularyEntry = { entry_id: string; word: string; list_number: number; list_position: number;
  cefr: Cefr; senses: VocabularySense[]; irregular_forms: IrregularForm[]; source_sha256: string };
export const CEFR_GROUPS = ["A1", "A2", "B1", "B2", "C1-C2"] as const;
export type CefrGroup = typeof CEFR_GROUPS[number];
export type ListSource = { kind: "list"; listNumber: number } | { kind: "cefr_list"; group: CefrGroup; listNumber: number };
export type RoundSource = ListSource | { kind: "cefr"; levels: Cefr[] };
export type VocabularyListCard = { edition: "mixed" | "cefr"; group: string; listNumber: number; count: number;
  status: "not_started" | "in_progress" | "completed"; bestAccuracy: number | null };
export type FormSpelling = { formType: IrregularFormType; spelling: string };
export type SpellingAnswer = { entryId: string; spelling: string; formType?: IrregularFormType; irregularSpellings?: FormSpelling[] };
export type AttemptSubmission = { attemptId: string; mode: SpellingMode; answers: SpellingAnswer[]; source?: RoundSource };
export type GradedForm = FormSpelling & { acceptedAnswers: string[]; correct: boolean; requiredAll?: boolean };
export type GradedAnswer = SpellingAnswer & { word: string; listNumber: number; listPosition: number;
  cefr: Cefr; senses: VocabularySense[]; acceptedAnswers: string[]; correct: boolean; sourceSha256: string;
  baseCorrect?: boolean; irregularResults?: GradedForm[]; source?: RoundSource };
export type VocabularyCatalog = { total: number; lists: { listNumber: number; count: number; irregularCount: number }[];
  cefr: { level: Cefr; count: number }[] };
export type AttemptSummary = { attempt_id: string; mode: SpellingMode; submitted_at: string;
  answer_count: number; correct_count: number; list_numbers: number[]; cefr_levels: Cefr[] };
export type AttemptResult = AttemptSummary & { answers: GradedAnswer[] };

// Reuse the wordbook's browser normalization, but NEVER its spelling_pos grading.
export const normalizeVocabularySpelling = normalizeReviewSpelling;
export function vocabularyAcceptedAnswers(entry: Pick<VocabularyEntry, "word" | "irregular_forms">,
  mode: SpellingMode, formType?: IrregularFormType): string[] {
  if (mode === "base_form") {
    if (formType !== undefined) throw new Error("CTW_VOCAB_INVALID_FORM_TYPE");
    return [entry.word];
  }
  const form = entry.irregular_forms.find(item => item.form_type === formType);
  if (!form) throw new Error("CTW_VOCAB_INVALID_FORM_TYPE");
  return [...form.answers];
}
// Browser feedback and batch server verification share this pure function.
// No per-word request and no database grading.
export function gradeVocabularySpelling(entry: Pick<VocabularyEntry, "word" | "irregular_forms">,
  mode: SpellingMode, spelling: string, formType?: IrregularFormType) {
  return vocabularyAcceptedAnswers(entry, mode, formType)
    .some(answer => normalizeVocabularySpelling(answer) === normalizeVocabularySpelling(spelling));
}
