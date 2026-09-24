import { canonicalSourceTextHash } from "./hash.ts";
import { normalizeLexicalSurface } from "./normalize.ts";
import type { LexicalBlockWork, LexicalTokenCandidate } from "./generationTypes.ts";
import type { CanonicalLexicalAnchor, CanonicalLexicalBlock } from "./types.ts";

const ENGLISH_TOKEN = new RegExp("\\p{Script=Latin}+(?:['’]\\p{Script=Latin}+)*(?:['’])?", "gu");

function containingAnchor(
  anchors: CanonicalLexicalAnchor[],
  startOffset: number,
  endOffset: number,
  kind?: CanonicalLexicalAnchor["anchorKind"]
) {
  return anchors.find((anchor) =>
    (kind === undefined || anchor.anchorKind === kind) &&
    anchor.startOffset !== undefined &&
    anchor.endOffset !== undefined &&
    startOffset >= anchor.startOffset &&
    endOffset <= anchor.endOffset
  ) ?? null;
}

function sentenceAnchor(anchors: CanonicalLexicalAnchor[], startOffset: number, endOffset: number) {
  return containingAnchor(anchors, startOffset, endOffset, "rap_sentence");
}

function sourceAnchor(anchors: CanonicalLexicalAnchor[], startOffset: number, endOffset: number) {
  return anchors.find((anchor) =>
    (anchor.anchorKind === "ctw_slot" || anchor.anchorKind === "rdl_word") &&
    anchor.startOffset !== undefined &&
    anchor.endOffset !== undefined &&
    startOffset >= anchor.startOffset &&
    endOffset <= anchor.endOffset
  ) ?? null;
}

export function tokenizeCanonicalBlock(block: CanonicalLexicalBlock): LexicalBlockWork {
  const sourceTextHash = canonicalSourceTextHash(block.text);
  const anchors = block.anchors ?? [];
  const tokens: LexicalTokenCandidate[] = [];
  ENGLISH_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ENGLISH_TOKEN.exec(block.text)) !== null) {
    const surfaceText = match[0];
    const startOffset = match.index;
    const endOffset = startOffset + surfaceText.length;
    const exclusion = containingAnchor(anchors, startOffset, endOffset, "coverage_exclusion");
    const lexicalAnchor = sourceAnchor(anchors, startOffset, endOffset);
    const sentence = sentenceAnchor(anchors, startOffset, endOffset);
    const reviewAnchor = containingAnchor(anchors, startOffset, endOffset);
    tokens.push({
      candidateId: `${block.sourceType}:${block.sourceItemId}:${block.contentBlockId}:${startOffset}:${endOffset}`,
      sourceType: block.sourceType,
      sourceItemId: block.sourceItemId,
      contentBlockId: block.contentBlockId,
      blockKind: block.blockKind,
      sourceTextHash,
      surfaceText,
      normalizedSurface: normalizeLexicalSurface(surfaceText),
      startOffset,
      endOffset,
      sourceAnchorId: lexicalAnchor?.anchorId ?? null,
      sentenceId: sentence?.anchorId ?? null,
      excluded: exclusion !== null,
      exclusionReason: exclusion === null ? null : String(exclusion.metadata?.reason ?? "explicit_exclusion"),
      sourceReviewReason: reviewAnchor?.metadata?.needsReview === 1
        ? String(reviewAnchor.metadata.reason ?? "source_uncertainty")
        : null
    });
  }
  return { block, sourceTextHash, tokens };
}

export function tokenizeCanonicalBlocks(blocks: CanonicalLexicalBlock[]) {
  return blocks.map(tokenizeCanonicalBlock);
}
