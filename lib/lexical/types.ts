export type CanonicalLexicalSourceType =
  | "ctw"
  | "rdl"
  | "rap"
  | "bas"
  | "write_email"
  | "academic_discussion";

export type CanonicalLexicalAnchorKind =
  | "ctw_slot"
  | "rdl_word"
  | "rdl_character"
  | "rap_sentence"
  | "rap_insertion_position"
  | "coverage_exclusion"
  | "canonical_question";

export type CanonicalLexicalAnchor = {
  anchorId: string;
  anchorKind: CanonicalLexicalAnchorKind;
  startOffset?: number;
  endOffset?: number;
  /** Participant names remain in canonical text but are excluded from future lexical coverage. */
  metadata?: Record<string, string | number | null>;
  expectedText?: string;
};

export type CanonicalLexicalBlock = {
  sourceType: CanonicalLexicalSourceType;
  sourceItemId: string;
  contentBlockId: string;
  blockKind: string;
  /** Exact canonical JS string. Offsets use UTF-16 code units and [start, end). */
  text: string;
  anchors?: CanonicalLexicalAnchor[];
};

export type RdlCanonicalCharacter = {
  charId: string;
  wordId: string;
  globalIndex: number;
  flatIndex: number;
  startOffset: number;
  endOffset: number;
  needsReview: boolean;
};

export type CanonicalLexicalSourceBlockRow = {
  source_type: CanonicalLexicalSourceType;
  source_item_id: string;
  content_block_id: string;
  source_text_hash: string;
};
