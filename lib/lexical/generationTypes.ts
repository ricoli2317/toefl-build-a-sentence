import type { CanonicalLexicalBlock, CanonicalLexicalSourceType } from "./types.ts";

export const LEXICAL_GENERATION_VERSION = "lexical-v1";

export const LEXICAL_POS_VALUES = [
  "noun",
  "verb",
  "adjective",
  "adverb",
  "pronoun",
  "determiner",
  "preposition",
  "conjunction",
  "auxiliary",
  "modal",
  "particle",
  "interjection",
  "proper_noun",
  "numeral",
  "other"
] as const;

export type LexicalPos = typeof LEXICAL_POS_VALUES[number];
export type LexicalExpressionType = "word" | "phrase" | "phrasal_verb" | "idiom" | "proper_noun";
export type LexicalReviewStatus = "generated" | "needs_review";

export type LexicalTokenCandidate = {
  candidateId: string;
  sourceType: CanonicalLexicalSourceType;
  sourceItemId: string;
  contentBlockId: string;
  blockKind: string;
  sourceTextHash: string;
  surfaceText: string;
  normalizedSurface: string;
  startOffset: number;
  endOffset: number;
  sourceAnchorId: string | null;
  sentenceId: string | null;
  excluded: boolean;
  exclusionReason: string | null;
  sourceReviewReason: string | null;
};

export type LexicalOccurrenceArtifact = {
  entry_key: string;
  source_type: CanonicalLexicalSourceType;
  source_item_id: string;
  content_block_id: string;
  sentence_id: string | null;
  source_anchor_id: string | null;
  surface_text: string;
  normalized_surface: string;
  start_offset: number;
  end_offset: number;
  context_pos: LexicalPos;
  context_meaning_zh: string;
  context_definition_en: string;
  context_text: string;
  review_status: LexicalReviewStatus;
  generation_version: typeof LEXICAL_GENERATION_VERSION;
  review_notes: string | null;
  layer: 1 | 2;
  expression_type: LexicalExpressionType;
  canonical_expression: string;
  normalized_expression: string;
  lemma: string;
};

export type LexicalEntryArtifact = {
  canonical_expression: string;
  normalized_expression: string;
  expression_type: LexicalExpressionType;
  lemma: string;
  common_senses: Array<{ pos: LexicalPos; definition_en: string; meaning_zh: string }>;
  derived_words: Array<{ expression: string; relation: string; meaning_zh: string }>;
  useful_patterns: Array<{ pattern: string; meaning_zh: string }>;
  review_status: LexicalReviewStatus;
  generation_version: typeof LEXICAL_GENERATION_VERSION;
  review_notes: string | null;
};

export type LexicalBlockWork = {
  block: CanonicalLexicalBlock;
  sourceTextHash: string;
  tokens: LexicalTokenCandidate[];
};

export function lexicalEntryKey(normalizedExpression: string, expressionType: LexicalExpressionType) {
  return `${normalizedExpression}\u0000${expressionType}`;
}
