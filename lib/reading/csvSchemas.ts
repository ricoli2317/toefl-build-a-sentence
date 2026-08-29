export const READING_SOURCE_HEADERS = [
  "source_label",
  "occurrence_date",
  "year_month",
  "source_module",
  "source_order",
  "source_group_id"
] as const;

export const COMPLETE_THE_WORDS_HEADERS = [
  ...READING_SOURCE_HEADERS,
  "source_question_start",
  "source_question_end",
  "question_stem",
  "raw_display_text",
  "passage_json",
  "slots_json"
] as const;

export const READ_IN_DAILY_LIFE_HEADERS = [
  ...READING_SOURCE_HEADERS,
  "source_question_number",
  "material_id",
  "material_type",
  "title",
  "question_order",
  "question_stem",
  "raw_display_text",
  "passage_highlights_json",
  "options_json",
  "correct_option_id"
] as const;

export const READ_AN_ACADEMIC_PASSAGE_HEADERS = [
  ...READING_SOURCE_HEADERS,
  "source_question_number",
  "passage_id",
  "passage_title",
  "passage_json",
  "question_order",
  "question_type",
  "question_stem",
  "raw_display_text",
  "options_json",
  "correct_option_id",
  "insert_sentence",
  "insertion_anchors_json",
  "correct_anchor_id",
  "target_paragraph_id",
  "correct_sentence_id"
] as const;

export type ReadingCsvType =
  | "complete_the_words"
  | "read_in_daily_life"
  | "read_an_academic_passage";

export const READING_CSV_TYPES = [
  "complete_the_words",
  "read_in_daily_life",
  "read_an_academic_passage"
] as const satisfies readonly ReadingCsvType[];
