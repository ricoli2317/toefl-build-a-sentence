import type { CanonicalLexicalBlock } from "../types.ts";
import { validateCanonicalLexicalBlocks } from "../validateCanonicalBlock.ts";
import { baselineRowsSha256 } from "./baselineHash.ts";

const blockIdentity = (block: CanonicalLexicalBlock) =>
  JSON.stringify([block.sourceType, block.sourceItemId, block.contentBlockId]);
const itemIdentity = (block: CanonicalLexicalBlock) =>
  JSON.stringify([block.sourceType, block.sourceItemId]);
const blockSignature = (block: CanonicalLexicalBlock) => baselineRowsSha256([{
  source_type: block.sourceType,
  source_item_id: block.sourceItemId,
  content_block_id: block.contentBlockId,
  block_kind: block.blockKind,
  text: block.text,
  anchors: block.anchors ?? []
}]);

/** Preserve the complete planned corpus; only wholly new source items may wait for a later run. */
export function assertCanonicalPlanCompatibility(expected: CanonicalLexicalBlock[], current: CanonicalLexicalBlock[]) {
  // Check both complete sets before indexing: duplicate/conflicting identities must never be hidden by a Map.
  validateCanonicalLexicalBlocks(expected);
  validateCanonicalLexicalBlocks(current);
  const planned = new Map(expected.map(block => [blockIdentity(block), block]));
  const live = new Map(current.map(block => [blockIdentity(block), block]));
  const plannedItems = new Set(expected.map(itemIdentity));
  for (const [identity, block] of Array.from(planned)) {
    const currentBlock = live.get(identity);
    if (!currentBlock || blockSignature(block) !== blockSignature(currentBlock)) {
      throw new Error(`Canonical source drifted since planning (${identity}); refuse stale delta publication/import.`);
    }
  }
  const deferred = current.filter(block => !planned.has(blockIdentity(block)));
  for (const block of deferred) {
    if (plannedItems.has(itemIdentity(block))) {
      throw new Error(`Canonical source drifted since planning: extra block in planned source item ${itemIdentity(block)}; refuse stale delta publication/import.`);
    }
  }
  return {
    compatible: true,
    planned_blocks_verified: expected.length,
    deferred_new_item_blocks: deferred.length,
    deferred_new_items: Array.from(new Set(deferred.map(itemIdentity))).sort()
  };
}
