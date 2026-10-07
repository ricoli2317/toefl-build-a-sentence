import type { CanonicalLexicalSourceType } from "./types.ts";

export type LexicalAccess = { kind: "reading" | "reading_wrongbook" | "reading_category" | "full_set" | "writing" | "bas"; attemptId: string; questionId?: string; setId?: never }
  | { kind: "bas_prompt"; questionId: string; setId: string; attemptId?: never };
export type LexicalLookupRequest = {
  access: LexicalAccess;
  sourceType: CanonicalLexicalSourceType;
  sourceItemId?: string;
  contentBlockId: string;
  startOffset: number;
  endOffset: number;
  selectedText: string;
  /** Exact visible canonical text. Server verifies against both authorized content and corpus hash. */
  blockText: string;
};
export type LexicalLookupEntry = {
  entry_id: string; canonical_expression: string; expression_type: string; lemma: string | null;
};
export type LexicalLookupOccurrence = {
  occurrence_id: string; entry_id: string; source_type: string; source_item_id: string; content_block_id: string;
  start_offset: number; end_offset: number; surface_text: string; context_pos: string | null;
  context_meaning_zh: string; context_definition_en: string | null; lexical_entries: LexicalLookupEntry;
};
export type LexicalLookupResult = { status: "unmatched" | "unavailable" } | {
  status: "matched"; match: "exact_phrase" | "exact_token" | "supplement_parent";
  entry: LexicalLookupEntry;
  occurrence: Omit<LexicalLookupOccurrence, "lexical_entries">;
};
export function parseLookupRequest(value: unknown): LexicalLookupRequest | null {
  if (!value || typeof value !== "object") return null;
  const v = value as LexicalLookupRequest;
  if (!["ctw", "rdl", "rap", "bas", "write_email", "academic_discussion"].includes(v.sourceType)
    || !v.access || !["reading", "reading_wrongbook", "reading_category", "full_set", "writing", "bas", "bas_prompt"].includes(v.access.kind)
    || (v.access.kind === "bas_prompt"
      ? typeof v.access.setId !== "string" || !v.access.setId || v.access.setId.length > 180 || !v.access.questionId
      : typeof v.access.attemptId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.access.attemptId))
    || (v.access.questionId != null && (typeof v.access.questionId !== "string" || v.access.questionId.length > 180))
    || typeof v.contentBlockId !== "string" || v.contentBlockId.length > 400
    || (v.sourceItemId != null && (typeof v.sourceItemId !== "string" || v.sourceItemId.length > 180))
    || typeof v.blockText !== "string" || v.blockText.length > 32000
    || typeof v.selectedText !== "string" || !v.selectedText.trim() || v.selectedText.length > 240
    || !Number.isInteger(v.startOffset) || !Number.isInteger(v.endOffset)
    || v.startOffset < 0 || v.endOffset <= v.startOffset || v.endOffset > v.blockText.length
    || v.blockText.slice(v.startOffset, v.endOffset) !== v.selectedText) return null;
  return v;
}
export function matchLexicalSelection(rows: LexicalLookupOccurrence[], request: Pick<LexicalLookupRequest,
  "sourceType" | "sourceItemId" | "contentBlockId" | "startOffset" | "endOffset" | "selectedText">): LexicalLookupResult {
  const scoped = rows.filter(r => r.source_type === request.sourceType && r.source_item_id === request.sourceItemId
    && r.content_block_id === request.contentBlockId);
  const exact = scoped.find(r => r.start_offset === request.startOffset && r.end_offset === request.endOffset && r.surface_text === request.selectedText);
  // Parent supplementation is only for a complete token with no occurrence of its own, never a partial word or arbitrary span.
  const parents = new RegExp("^[\\p{L}\\p{N}]+(?:['’\\-][\\p{L}\\p{N}]+)*$", "u").test(request.selectedText)
    ? scoped.filter(r => r.lexical_entries.expression_type !== "word" && r.start_offset <= request.startOffset && r.end_offset >= request.endOffset
      && r.surface_text.slice(request.startOffset - r.start_offset, request.endOffset - r.start_offset) === request.selectedText
      && !new RegExp("[\\p{L}\\p{N}]", "u").test(r.surface_text[request.startOffset - r.start_offset - 1] ?? "")
      && !new RegExp("[\\p{L}\\p{N}]", "u").test(r.surface_text[request.endOffset - r.start_offset] ?? ""))
      .sort((a,b) => (a.end_offset - a.start_offset) - (b.end_offset - b.start_offset) || a.occurrence_id.localeCompare(b.occurrence_id)) : [];
  const row = exact ?? parents[0];
  if (!row) return { status: "unmatched" };
  const { lexical_entries } = row;
  return { status: "matched", match: exact ? lexical_entries.expression_type === "word" ? "exact_token" : "exact_phrase" : "supplement_parent",
    entry: { entry_id: lexical_entries.entry_id, canonical_expression: lexical_entries.canonical_expression,
      expression_type: lexical_entries.expression_type, lemma: lexical_entries.lemma },
    occurrence: { occurrence_id: row.occurrence_id, entry_id: row.entry_id, source_type: row.source_type,
      source_item_id: row.source_item_id, content_block_id: row.content_block_id, start_offset: row.start_offset,
      end_offset: row.end_offset, surface_text: row.surface_text, context_pos: row.context_pos,
      context_meaning_zh: row.context_meaning_zh, context_definition_en: row.context_definition_en } };
}
