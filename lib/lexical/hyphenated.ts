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

/** Explicit audit-bound additions, not a blanket extension of the frozen tokenizer.
 * Numeric modifiers / technical names can have only one Latin token or end in digits.
 * Accept only complete canonical hyphen spans from the caller's reviewed whitelist.
 */
export function validateApprovedHyphenatedSpans(blocks: CanonicalLexicalBlock[], approved: HyphenatedCompound[]) {
  const byBlock = new Map(blocks.map(b => [JSON.stringify([b.sourceType, b.sourceItemId, b.contentBlockId]), b]));
  const known = new Set(blocks.flatMap(hyphenatedCompounds).map(spanKey));
  const seen = new Set<string>();
  const segment = "[\\p{Script=Latin}\\p{N}]+(?:['’][\\p{Script=Latin}\\p{N}]+)*";
  const numericCompound = new RegExp(`^${segment}(?:[-\u2010\u2011]${segment})+$`, "u");
  const boundary = new RegExp("[\\p{L}\\p{N}'’\\-\u2010\u2011]", "u");
  const latin = new RegExp("\\p{Script=Latin}", "u");
  for (const span of approved) {
    const key = spanKey(span);
    const block = byBlock.get(JSON.stringify([span.source_type, span.source_item_id, span.content_block_id]));
    if (seen.has(key) || !block || !Number.isInteger(span.start_offset) || !Number.isInteger(span.end_offset)
      || span.start_offset < 0 || span.end_offset <= span.start_offset || span.end_offset > block.text.length
      || span.context_text !== block.text || block.text.slice(span.start_offset, span.end_offset) !== span.surface_text) throw new Error("Invalid or duplicate approved hyphen span/context.");
    seen.add(key);
    if (!known.has(key)) {
      const excluded = tokenizeCanonicalBlock(block).tokens.some(t => t.excluded && t.startOffset < span.end_offset && t.endOffset > span.start_offset);
      if (!/[0-9]/.test(span.surface_text) || !latin.test(span.surface_text) || !numericCompound.test(span.surface_text)
        || boundary.test(block.text.slice(span.start_offset - 1, span.start_offset)) || boundary.test(block.text.slice(span.end_offset, span.end_offset + 1))
        || excluded) throw new Error("Approved repair span is not a complete eligible hyphenated lexical compound.");
    }
  }
  return approved;
}

export function approvedHyphenatedCoverage(blocks: CanonicalLexicalBlock[], occurrences: OccurrenceSpan[], approved: HyphenatedCompound[]) {
  validateApprovedHyphenatedSpans(blocks, approved);
  const spans = new Set(occurrences.map(spanKey));
  return { total: approved.length, covered: approved.filter(c => spans.has(spanKey(c))).length,
    missing: approved.filter(c => !spans.has(spanKey(c))) };
}
