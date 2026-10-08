export class WordbookError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 409, message = "无法核验收藏语境，请重新选择或刷新页面。") { super(message); this.code = code; this.status = status; }
}
export type ContextOccurrence = {
  start_offset: number; end_offset: number; surface_text: string; context_text: string; sentence_id: string | null;
};
export type WordbookContext = {
  example_text: string | null; context_kind: "sentence" | "fragment" | null; extraction_method: string;
};
type Sentence = { sentence_id: string; sentence_text: string };
const noExample = (): WordbookContext => ({ example_text: null, context_kind: null, extraction_method: "verified_no_example_boundary" });
// Boundary recognition is not grammar validation. Ordinary finite verbs and
// imperatives are not limited to a small auxiliary/verb whitelist.
const complete = (text: string) => /[.!?][”"')\]]*$/.test(text.trim())
  && (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length ?? 0) >= 3;

export function verifyWordbookOccurrence(text: string, o: ContextOccurrence) {
  if (o.context_text !== text) throw new WordbookError("CANONICAL_CONTEXT_STALE");
  if (!Number.isInteger(o.start_offset) || !Number.isInteger(o.end_offset) || o.start_offset < 0
    || o.end_offset <= o.start_offset || o.end_offset > text.length || text.slice(o.start_offset, o.end_offset) !== o.surface_text)
    throw new WordbookError("OCCURRENCE_SPAN_MISMATCH");
}

/** Exact UTF-16 slices only. No model, generated text, character windows or long-block fallback. */
export function extractWordbookContext(text: string, kind: string, o: ContextOccurrence, sentences?: Sentence[]): WordbookContext {
  verifyWordbookOccurrence(text, o);
  if (sentences) {
    if (!sentences.length || sentences.map(s => s.sentence_text).join(" ") !== text) throw new WordbookError("CANONICAL_SENTENCE_STALE");
    let offset = 0;
    const matches = sentences.filter(s => {
      const start = offset; offset += s.sentence_text.length + 1;
      return start <= o.start_offset && offset - 1 >= o.end_offset;
    });
    if (o.sentence_id && (matches.length !== 1 || matches[0].sentence_id !== o.sentence_id)) throw new WordbookError("CANONICAL_SENTENCE_STALE");
    if (matches.length !== 1) return noExample();
    return { example_text: matches[0].sentence_text, context_kind: "sentence", extraction_method: "canonical_sentence" };
  }
  // Titles/subjects remain honest fragments even when they end in a period.
  if (/(?:_title|_subject)$/.test(kind)) {
    if (text.length > 600 || /\n\s*\n/.test(text)) return noExample();
    return { example_text: text, context_kind: "fragment", extraction_method: "whole_fragment_block" };
  }
  // A dotted acronym/abbreviation before a capital may be either an internal
  // abbreviation or a sentence end. Do not silently merge two sentences.
  const paragraphs = Array.from(text.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g));
  const paragraph = paragraphs.find(p => p.index! <= o.start_offset && p.index! + p[0].length >= o.end_offset);
  // An unrelated hours/acronym block elsewhere in an RDL document must not
  // invalidate this occurrence's sentence. Natural paragraphs bound uncertainty.
  const ambiguousAbbreviation = /\b(?:(?:[A-Z]\.){2,}|etc\.|e\.g\.|i\.e\.|Inc\.|Ltd\.|Corp\.)\s+[“"']?[A-Z]/.test(paragraph?.[0] ?? text);
  // Mask familiar non-terminal periods without changing string length/offsets.
  const scope = paragraph?.[0] ?? text;
  const scopeStart = paragraph?.index ?? 0;
  const protectedText = scope.replace(/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)\.|\b(?:[A-Z]\.){1,}|\b(?:e\.g\.|i\.e\.)|\d\.\d/g,
    value => value.replace(/\./g, "\uE000"));
  // Segment only the containing natural paragraph. Masking a terminal acronym
  // in an unrelated paragraph must not merge it into this occurrence's sentence.
  // Translate back to global UTF-16 offsets before matching/slicing canonical text.
  const segments = Array.from(new Intl.Segmenter("en", { granularity: "sentence" }).segment(protectedText))
    .map(s => ({ index: s.index + scopeStart, segment: s.segment }));
  const candidates = segments.filter(s => s.index <= o.start_offset && s.index + s.segment.trimEnd().length >= o.end_offset);
  if (candidates.length === 1 && !ambiguousAbbreviation) {
    const s = candidates[0]; const slice = text.slice(s.index, s.index + s.segment.trimEnd().length);
    // Segmenter can split an unknown abbreviated proper name. An uncertain
    // previous boundary must not authorize saving a chopped partial sentence.
    const previous = scope.slice(0, s.index - scopeStart).trimEnd();
    const uncertainStart = s.index > scopeStart && /\b(?:[A-Z]|Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|Inc|Ltd|Corp)\.[”"')\]]*$/.test(previous);
    // Multiline layouts and ellipses are ambiguous; do not promote to sentence.
    if (!uncertainStart && complete(slice) && !/\n|\.{2,}|…/.test(slice.trim())) return {
      example_text: slice, context_kind: "sentence",
      extraction_method: segments.length === 1 && scope === text ? "whole_sentence_block" : "verified_sentence_span"
    };
  }
  // Natural paragraph boundaries can preserve a short fragment; never truncate.
  if (paragraph && paragraph[0].length <= 600 && !/[.!?]\s+[A-Z]/.test(paragraph[0])) return {
    example_text: paragraph[0], context_kind: "fragment",
    extraction_method: paragraph[0] === text ? "whole_fragment_block" : "verified_fragment_span"
  };
  return noExample();
}
