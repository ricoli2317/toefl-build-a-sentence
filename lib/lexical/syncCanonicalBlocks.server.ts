import { canonicalSourceTextHash } from "./hash.ts";
import type { CanonicalLexicalBlock, CanonicalLexicalSourceBlockRow } from "./types.ts";
import { validateCanonicalLexicalBlocks } from "./validateCanonicalBlock.ts";

export type CanonicalBlockSyncPlanEntry = {
  action: "new" | "same" | "changed" | "removed";
  sourceType: CanonicalLexicalBlock["sourceType"];
  sourceItemId: string;
  contentBlockId: string;
  block?: CanonicalLexicalBlock;
};

/** Plans only. Persistence is deliberately out of scope for Step 5 and must be dry-run by default. */
export function planCanonicalBlockSync(input: {
  sourceType: CanonicalLexicalBlock["sourceType"];
  sourceItemId: string;
  enumeration: { success: true; blocks: CanonicalLexicalBlock[] } | { success: false; error: Error };
  existing: CanonicalLexicalSourceBlockRow[];
}): CanonicalBlockSyncPlanEntry[] {
  if (!input.enumeration.success) return [];
  const blocks = validateCanonicalLexicalBlocks(input.enumeration.blocks);
  if (!blocks.length) throw new Error("A successful canonical source item enumeration cannot be empty.");
  const keyFor = (contentBlockId: string) => `${input.sourceType}:${input.sourceItemId}:${contentBlockId}`;
  const existing = new Map(input.existing.map((row) => [
    `${row.source_type}:${row.source_item_id}:${row.content_block_id}`,
    row
  ]));
  const plan: CanonicalBlockSyncPlanEntry[] = [];
  for (const block of blocks) {
    if (block.sourceType !== input.sourceType || block.sourceItemId !== input.sourceItemId) {
      throw new Error("Sync plan accepts exactly one successfully enumerated source item.");
    }
    const current = existing.get(keyFor(block.contentBlockId));
    const action = !current ? "new" : current.source_text_hash === canonicalSourceTextHash(block.text) ? "same" : "changed";
    plan.push({ action, sourceType: block.sourceType, sourceItemId: block.sourceItemId, contentBlockId: block.contentBlockId, block });
    existing.delete(keyFor(block.contentBlockId));
  }
  for (const row of Array.from(existing.values())) {
    if (row.source_type === input.sourceType && row.source_item_id === input.sourceItemId) {
      plan.push({ action: "removed", sourceType: input.sourceType, sourceItemId: input.sourceItemId, contentBlockId: row.content_block_id });
    }
  }
  return plan.sort((left, right) => left.contentBlockId.localeCompare(right.contentBlockId));
}
