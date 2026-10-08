export class WordbookError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 409, message = "无法核验收藏语境，请重新选择或刷新页面。") { super(message); this.code = code; this.status = status; }
}
export type ContextOccurrence = {
  start_offset: number; end_offset: number; surface_text: string; context_text: string; sentence_id: string | null;
};
export type WordbookContext = {
  example_text: string; context_kind: "sentence" | "fragment"; extraction_method: string;
};
type Sentence = { sentence_id: string; sentence_text: string };
const fail = () => { throw new WordbookError("UNVERIFIABLE_CONTEXT_BOUNDARY", 422, "无法可靠提取原句或短片段，本次未收藏。请尝试其他语境。"); };
// A conservative recognizer, not a grammar model: uncertain text stays fragment.
const complete = (text: string) => /[.!?][”"')\]]*$/.test(text.trim())
  && (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length ?? 0) >= 3
  && /\b(?:am|is|are|was|were|has|have|had|do|does|did|can|could|will|would|shall|should|may|might|must)\b|^(?:Please\s+)?(?:Select|Choose|Explain|Describe|Write|Discuss|Consider)\b/i.test(text.trim());

/** Exact UTF-16 slices only. No model, generated text, character windows or long-block fallback. */
export function extractWordbookContext(text: string, kind: string, o: ContextOccurrence, sentences?: Sentence[]): WordbookContext {
  if (o.context_text !== text) throw new WordbookError("CANONICAL_CONTEXT_STALE");
  if (!Number.isInteger(o.start_offset) || !Number.isInteger(o.end_offset) || o.start_offset < 0
    || o.end_offset <= o.start_offset || o.end_offset > text.length || text.slice(o.start_offset, o.end_offset) !== o.surface_text)
    throw new WordbookError("OCCURRENCE_SPAN_MISMATCH");
  if (sentences) {
    if (!sentences.length || sentences.map(s => s.sentence_text).join(" ") !== text) return fail();
    let offset = 0;
    const matches = sentences.filter(s => {
      const start = offset; offset += s.sentence_text.length + 1;
      return start <= o.start_offset && offset - 1 >= o.end_offset;
    });
    if (matches.length !== 1 || (o.sentence_id && matches[0].sentence_id !== o.sentence_id)) return fail();
    return { example_text: matches[0].sentence_text, context_kind: "sentence", extraction_method: "canonical_sentence" };
  }
  // Titles/subjects remain honest fragments even when they end in a period.
  if (/(?:_title|_subject)$/.test(kind)) {
    if (text.length > 600 || /\n\s*\n/.test(text)) return fail();
    return { example_text: text, context_kind: "fragment", extraction_method: "whole_fragment_block" };
  }
  // A dotted acronym/abbreviation before a capital may be either an internal
  // abbreviation or a sentence end. Do not silently merge two sentences.
  const ambiguousAbbreviation = /\b(?:(?:[A-Z]\.){2,}|etc\.|e\.g\.|i\.e\.|Inc\.|Ltd\.|Corp\.)\s+[“"']?[A-Z]/.test(text);
  // Mask familiar non-terminal periods without changing string length/offsets.
  const protectedText = text.replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)\.|\b(?:[A-Z]\.){1,}|\b(?:e\.g\.|i\.e\.)|\d\.\d/g,
    value => value.replace(/\./g, "\uE000"));
  const segments = Array.from(new Intl.Segmenter("en", { granularity: "sentence" }).segment(protectedText));
  const candidates = segments.filter(s => s.index <= o.start_offset && s.index + s.segment.trimEnd().length >= o.end_offset);
  if (candidates.length === 1 && !ambiguousAbbreviation) {
    const s = candidates[0]; const slice = text.slice(s.index, s.index + s.segment.trimEnd().length);
    // Segmenter can split an unknown abbreviated proper name. An uncertain
    // previous boundary must not authorize saving a chopped partial sentence.
    const previous = text.slice(0, s.index).trimEnd();
    const uncertainStart = s.index > 0 && /\b(?:[A-Za-z]{1,3}|[A-Z][a-z]{0,5})\.[”"')\]]*$/.test(previous);
    // Multiline layouts and ellipses are ambiguous; do not promote to sentence.
    if (!uncertainStart && complete(slice) && !/\n|\.{2,}|…/.test(slice)) return {
      example_text: slice, context_kind: "sentence",
      extraction_method: segments.length === 1 ? "whole_sentence_block" : "verified_sentence_span"
    };
  }
  // Natural paragraph boundaries can preserve a short fragment; never truncate.
  const paragraphs = Array.from(text.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g));
  const paragraph = paragraphs.find(p => p.index! <= o.start_offset && p.index! + p[0].length >= o.end_offset);
  if (paragraph && paragraph[0].length <= 600 && !/[.!?]\s+[A-Z]/.test(paragraph[0])) return {
    example_text: paragraph[0], context_kind: "fragment",
    extraction_method: paragraph[0] === text ? "whole_fragment_block" : "verified_fragment_span"
  };
  return fail();
}
