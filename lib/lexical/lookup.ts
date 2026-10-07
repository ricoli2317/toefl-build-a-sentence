import type { CanonicalLexicalSourceType } from "./types.ts";
import { normalizeLexicalSurface } from "./normalize.ts";

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
  /** Edits never change the source span or authorize searching elsewhere. */
  query?: string;
  /** A visible CTW projection onto an existing paragraph segment/slot anchor. */
  ctwAnchor?: { kind: "text"; segmentIndex: number } | { kind: "slot"; slotId: string };
};
export type LexicalLookupEntry = {
  entry_id: string; canonical_expression: string; expression_type: string; lemma: string | null;
};
export type LexicalLookupOccurrence = {
  occurrence_id: string; entry_id: string; source_type: string; source_item_id: string; content_block_id: string;
  start_offset: number; end_offset: number; surface_text: string; context_pos: string | null;
  context_meaning_zh: string; context_definition_en: string | null; lexical_entries: LexicalLookupEntry & { normalized_expression?: string };
};
export type LexicalLookupPhrase = { entry: LexicalLookupEntry; occurrence: Omit<LexicalLookupOccurrence, "lexical_entries"> };
export type LexicalLookupResult = { status: "unmatched" | "unavailable" } | {
  status: "matched"; match: "exact_phrase" | "exact_token" | "entry_expression" | "supplement_parent";
  entry: LexicalLookupEntry;
  occurrence: Omit<LexicalLookupOccurrence, "lexical_entries">;
  containingPhrases?: LexicalLookupPhrase[];
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
    || v.blockText.slice(v.startOffset, v.endOffset) !== v.selectedText
    || (v.query != null && (typeof v.query !== "string" || v.query.length > 240))
    || (v.ctwAnchor != null && (v.sourceType !== "ctw" || !v.contentBlockId.startsWith("paragraph:")
      || (v.ctwAnchor.kind === "text" ? !Number.isInteger(v.ctwAnchor.segmentIndex) || v.ctwAnchor.segmentIndex < 0
        : v.ctwAnchor.kind !== "slot" || typeof v.ctwAnchor.slotId !== "string" || !v.ctwAnchor.slotId || v.ctwAnchor.slotId.length > 180)))) return null;
  return v;
}
/** Only boundary punctuation/whitespace is stripped; internal apostrophes and hyphens are untouched. */
export function lexicalSelectionBounds(text: string) {
  let start = 0; let end = text.length;
  const boundary = new RegExp("[\\s\\p{P}]", "u");
  while (start < end && boundary.test(text[start])) start++;
  while (end > start && boundary.test(text[end - 1])) end--;
  return { start, end, text: text.slice(start, end) };
}
export const normalizeLookupQuery = (text: string) => normalizeLexicalSurface(lexicalSelectionBounds(text).text);
const bySpan = (a: LexicalLookupOccurrence, b: LexicalLookupOccurrence) =>
  (a.end_offset - a.start_offset) - (b.end_offset - b.start_offset) || a.occurrence_id.localeCompare(b.occurrence_id);
function lookupValue(row: LexicalLookupOccurrence): LexicalLookupPhrase {
  const { lexical_entries: e } = row;
  return { entry: { entry_id: e.entry_id, canonical_expression: e.canonical_expression, expression_type: e.expression_type, lemma: e.lemma },
    occurrence: { occurrence_id: row.occurrence_id, entry_id: row.entry_id, source_type: row.source_type,
      source_item_id: row.source_item_id, content_block_id: row.content_block_id, start_offset: row.start_offset,
      end_offset: row.end_offset, surface_text: row.surface_text, context_pos: row.context_pos,
      context_meaning_zh: row.context_meaning_zh, context_definition_en: row.context_definition_en } };
}
export function matchLexicalSelection(rows: LexicalLookupOccurrence[], request: Pick<LexicalLookupRequest,
  "sourceType" | "sourceItemId" | "contentBlockId" | "startOffset" | "endOffset" | "selectedText" | "query">): LexicalLookupResult {
  const scoped = rows.filter(r => r.source_type === request.sourceType && r.source_item_id === request.sourceItemId
    && r.content_block_id === request.contentBlockId).sort(bySpan);
  const bounds = lexicalSelectionBounds(request.selectedText);
  const start = request.startOffset + bounds.start; const end = request.startOffset + bounds.end;
  const query = normalizeLookupQuery(request.query ?? request.selectedText);
  if (!query || start >= end) return { status: "unmatched" };
  const rawExact = scoped.find(r => r.start_offset === request.startOffset && r.end_offset === request.endOffset && r.surface_text === request.selectedText
    && normalizeLookupQuery(r.surface_text) === query);
  const exact = rawExact ?? scoped.find(r => r.start_offset === start && r.end_offset === end && r.surface_text === bounds.text
    && normalizeLookupQuery(r.surface_text) === query);
  // Containment alone is never a match: the edited/selected query must be this unique local entry's identity.
  const tokens = scoped.filter(r => r.lexical_entries.expression_type === "word" && r.start_offset <= start && r.end_offset >= end
    && r.surface_text.slice(start - r.start_offset, end - r.start_offset) === bounds.text);
  const entryExpression = tokens.length === 1 && query === tokens[0].lexical_entries.normalized_expression ? tokens[0] : undefined;
  // Parent supplementation is only for a complete token with no occurrence of its own, never a partial word or arbitrary span.
  const token = new RegExp("^[\\p{L}\\p{N}]+(?:['’\\-][\\p{L}\\p{N}]+)*$", "u");
  const tokenPart = new RegExp("[\\p{L}\\p{N}'’\\-]", "u");
  const parents = !tokens.length && query === normalizeLookupQuery(bounds.text) && token.test(bounds.text)
    ? scoped.filter(r => r.lexical_entries.expression_type !== "word" && r.start_offset <= start && r.end_offset >= end
      && r.surface_text.slice(start - r.start_offset, end - r.start_offset) === bounds.text
      && !tokenPart.test(r.surface_text[start - r.start_offset - 1] ?? "")
      && !tokenPart.test(r.surface_text[end - r.start_offset] ?? "")) : [];
  const row = exact ?? entryExpression ?? parents[0];
  if (!row) return { status: "unmatched" };
  const seen = new Set<string>();
  const containingPhrases = row.lexical_entries.expression_type === "word" ? scoped.filter(r =>
    ["phrase", "phrasal_verb", "idiom", "proper_noun"].includes(r.lexical_entries.expression_type)
    && r.start_offset <= row.start_offset && r.end_offset >= row.end_offset && r.occurrence_id !== row.occurrence_id
    && (r.start_offset < row.start_offset || r.end_offset > row.end_offset)
    // A containing span must also agree with the actual token surface.
    && r.surface_text.slice(row.start_offset - r.start_offset, row.end_offset - r.start_offset) === row.surface_text)
    .filter(r => { const key = normalizeLexicalSurface(r.lexical_entries.canonical_expression); if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, 3).map(lookupValue) : [];
  return { status: "matched", match: exact ? row.lexical_entries.expression_type === "word" ? "exact_token" : "exact_phrase"
    : entryExpression ? "entry_expression" : "supplement_parent", ...lookupValue(row),
    ...(containingPhrases.length ? { containingPhrases } : {}) };
}
