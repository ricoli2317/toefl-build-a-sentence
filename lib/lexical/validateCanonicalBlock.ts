import { canonicalSourceTextHash } from "./hash.ts";
import type { CanonicalLexicalBlock } from "./types.ts";

export class CanonicalLexicalValidationError extends Error {}

const SOURCE_TYPES = new Set([
  "ctw",
  "rdl",
  "rap",
  "bas",
  "write_email",
  "academic_discussion"
]);

export function validateCanonicalLexicalBlocks(blocks: CanonicalLexicalBlock[]) {
  const keys = new Set<string>();
  for (const block of blocks) {
    if (!SOURCE_TYPES.has(block.sourceType) || !block.sourceItemId || !block.contentBlockId) {
      throw new CanonicalLexicalValidationError("Canonical lexical block identity must be non-empty.");
    }
    if (!block.text) throw new CanonicalLexicalValidationError(`Canonical lexical block ${block.contentBlockId} has empty text.`);
    const key = `${block.sourceType}:${block.sourceItemId}:${block.contentBlockId}`;
    if (keys.has(key)) throw new CanonicalLexicalValidationError(`Duplicate canonical lexical block: ${key}`);
    keys.add(key);
    const anchorIds = new Set<string>();
    for (const anchor of block.anchors ?? []) {
      if (!anchor.anchorId || anchorIds.has(anchor.anchorId)) {
        throw new CanonicalLexicalValidationError(`Canonical lexical block ${key} has an empty or duplicate anchor identity.`);
      }
      anchorIds.add(anchor.anchorId);
      const hasStart = anchor.startOffset !== undefined;
      const hasEnd = anchor.endOffset !== undefined;
      if (hasStart !== hasEnd) throw new CanonicalLexicalValidationError(`Anchor ${anchor.anchorId} has an incomplete UTF-16 range.`);
      if (anchor.expectedText !== undefined && (!hasStart || !hasEnd)) {
        throw new CanonicalLexicalValidationError(`Anchor ${anchor.anchorId} has expected text without a UTF-16 range.`);
      }
      if (!hasStart || !hasEnd) continue;
      const startOffset = anchor.startOffset!;
      const endOffset = anchor.endOffset!;
      if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)
        || startOffset < 0 || startOffset >= endOffset || endOffset > block.text.length) {
        throw new CanonicalLexicalValidationError(`Anchor ${anchor.anchorId} has an invalid UTF-16 range.`);
      }
      if (anchor.expectedText !== undefined && block.text.slice(startOffset, endOffset) !== anchor.expectedText) {
        throw new CanonicalLexicalValidationError(`Anchor ${anchor.anchorId} does not slice to its expected canonical text.`);
      }
    }
  }
  return blocks;
}

export function assertDeterministicCanonicalEnumeration(
  enumerate: () => CanonicalLexicalBlock[]
) {
  const first = validateCanonicalLexicalBlocks(enumerate());
  const second = validateCanonicalLexicalBlocks(enumerate());
  const serialize = (blocks: CanonicalLexicalBlock[]) => JSON.stringify(blocks);
  if (serialize(first) !== serialize(second)) {
    throw new CanonicalLexicalValidationError("Canonical lexical enumeration is not deterministic.");
  }
  for (let index = 0; index < first.length; index += 1) {
    if (canonicalSourceTextHash(first[index].text) !== canonicalSourceTextHash(second[index].text)) {
      throw new CanonicalLexicalValidationError("Canonical source hash is not deterministic.");
    }
  }
  return first;
}
