import type { CanonicalLexicalBlock } from "./types.ts";
import { tokenizeCanonicalBlock } from "./tokenize.ts";

type OccurrenceSpan = {
  source_type: string; source_item_id: string; content_block_id: string;
  start_offset: number; end_offset: number; surface_text: string;
};

export type HyphenatedCompound = OccurrenceSpan & { context_text: string };
const spanKey = (o: OccurrenceSpan) => JSON.stringify([
  o.source_type, o.source_item_id, o.content_block_id, o.start_offset, o.end_offset, o.surface_text
]);

/** Lexical hyphens only: not date/number separators or spaced en/em-dash punctuation.
 * Keep exact UTF-16 slices; do not normalize away internal hyphens or exclude repeated uses.
 */
export function hyphenatedCompounds(block: CanonicalLexicalBlock): HyphenatedCompound[] {
  const word = "\\p{Script=Latin}+(?:['’]\\p{Script=Latin}+)*";
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}'’\\-\u2010\u2011])${word}(?:[-\u2010\u2011]${word})+(?![\\p{L}\\p{N}'’\\-\u2010\u2011])`, "gu");
  const excluded = tokenizeCanonicalBlock(block).tokens.filter(t => t.excluded);
  return Array.from(block.text.matchAll(pattern)).flatMap(match => {
    const start = match.index, end = start + match[0].length;
    if (excluded.some(t => t.startOffset < end && t.endOffset > start)) return [];
    return [{ source_type: block.sourceType, source_item_id: block.sourceItemId,
      content_block_id: block.contentBlockId, start_offset: start, end_offset: end,
      surface_text: match[0], context_text: block.text }];
  });
}

export function hyphenatedCoverage(blocks: CanonicalLexicalBlock[], occurrences: OccurrenceSpan[]) {
  const spans = new Set(occurrences.map(spanKey));
  const compounds = blocks.flatMap(hyphenatedCompounds);
  const missing = compounds.filter(c => !spans.has(spanKey(c)));
  return { total: compounds.length, covered: compounds.length - missing.length, missing };
}

export function assertHyphenatedCoverage(blocks: CanonicalLexicalBlock[], occurrences: OccurrenceSpan[]) {
  const coverage = hyphenatedCoverage(blocks, occurrences);
  if (coverage.missing.length) throw new Error(`Missing complete hyphenated occurrences (${coverage.missing.length}): ${JSON.stringify(coverage.missing.map(({ context_text, ...span }) => span))}`);
  return coverage;
}
