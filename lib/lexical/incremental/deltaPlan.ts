import { canonicalSourceTextHash } from "../hash.ts";
import type { CanonicalLexicalBlock, CanonicalLexicalSourceType } from "../types.ts";
import { blockIdentityKey, type ProductionBlockRow } from "./productionBaseline.server.ts";

export type DeltaPlanBlock = {
  source_type: CanonicalLexicalSourceType;
  source_item_id: string;
  content_block_id: string;
  block_kind: string;
  old_hash: string | null;
  new_hash: string | null;
  reason: "missing_in_production" | "source_text_hash_changed" | "missing_in_canonical";
};

export type DeltaPlan = {
  version: "lexical-incremental-delta-plan-v1";
  production_baseline: Record<string, unknown>;
  canonical_current: {
    items: Record<string, number>;
    blocks: Record<string, number>;
    total_items: number;
    total_blocks: number;
  };
  per_source_counts: Record<string, {
    production: { items: number; blocks: number };
    canonical: { items: number; blocks: number };
    delta: { new: number; changed: number; removed: number; unchanged: number };
  }>;
  delta_items: {
    new: string[];
    changed: string[];
    removed: string[];
  };
  new_blocks: DeltaPlanBlock[];
  changed_blocks: DeltaPlanBlock[];
  removed_blocks: DeltaPlanBlock[];
  unchanged_blocks: Array<{
    source_type: CanonicalLexicalSourceType;
    source_item_id: string;
    content_block_id: string;
    content_kind: string;
    source_text_hash: string;
  }>;
};

export function buildDeltaPlan(input: {
  canonicalBlocks: CanonicalLexicalBlock[];
  productionBlocks: ProductionBlockRow[];
  productionBaseline: Record<string, unknown>;
}): DeltaPlan {
  const canonicalKeyOf = (block: CanonicalLexicalBlock) =>
    `${block.sourceType}:${block.sourceItemId}:${block.contentBlockId}`;
  const canonicalByKey = new Map<string, CanonicalLexicalBlock>();
  for (const block of input.canonicalBlocks) {
    const key = canonicalKeyOf(block);
    if (canonicalByKey.has(key)) throw new Error(`Duplicate canonical block ${key}.`);
    canonicalByKey.set(key, block);
  }
  const productionByKey = new Map<string, ProductionBlockRow>();
  for (const block of input.productionBlocks) {
    const key = blockIdentityKey(block);
    if (productionByKey.has(key)) throw new Error(`Duplicate production block ${key}.`);
    productionByKey.set(key, block);
  }
  assertRapTitleCoverage(input.canonicalBlocks);

  const newBlocks: DeltaPlanBlock[] = [];
  const changedBlocks: DeltaPlanBlock[] = [];
  const removedBlocks: DeltaPlanBlock[] = [];
  const unchangedBlocks: DeltaPlan["unchanged_blocks"] = [];
  const sourceTypes = Array.from(new Set([
    ...input.canonicalBlocks.map((block) => block.sourceType),
    ...input.productionBlocks.map((block) => block.source_type)
  ])).sort();

  const emptyCounts = () => ({ new: 0, changed: 0, removed: 0, unchanged: 0 });
  const perSource = new Map<string, { production: { items: Set<string>; blocks: number }; canonical: { items: Set<string>; blocks: number }; delta: ReturnType<typeof emptyCounts> }>();
  const sourceEntry = (sourceType: string) => {
    if (!perSource.has(sourceType)) {
      perSource.set(sourceType, {
        production: { items: new Set(), blocks: 0 },
        canonical: { items: new Set(), blocks: 0 },
        delta: emptyCounts()
      });
    }
    return perSource.get(sourceType)!;
  };

  for (const block of input.canonicalBlocks) {
    const entry = sourceEntry(block.sourceType);
    entry.canonical.items.add(block.sourceItemId);
    entry.canonical.blocks += 1;
  }
  for (const block of input.productionBlocks) {
    const entry = sourceEntry(block.source_type);
    entry.production.items.add(block.source_item_id);
    entry.production.blocks += 1;
  }

  const newItems = new Set<string>();
  const changedItems = new Set<string>();
  const removedItems = new Set<string>();
  const itemKey = (sourceType: string, sourceItemId: string) => `${sourceType}:${sourceItemId}`;

  for (const block of input.canonicalBlocks) {
    const key = canonicalKeyOf(block);
    const existing = productionByKey.get(key);
    const newHash = canonicalSourceTextHash(block.text);
    const record = {
      source_type: block.sourceType,
      source_item_id: block.sourceItemId,
      content_block_id: block.contentBlockId,
      block_kind: block.blockKind,
      old_hash: existing?.source_text_hash ?? null,
      new_hash: newHash
    };
    if (!existing) {
      newBlocks.push({ ...record, reason: "missing_in_production" });
      newItems.add(itemKey(block.sourceType, block.sourceItemId));
      sourceEntry(block.sourceType).delta.new += 1;
    } else if (existing.source_text_hash !== newHash) {
      changedBlocks.push({ ...record, reason: "source_text_hash_changed" });
      changedItems.add(itemKey(block.sourceType, block.sourceItemId));
      sourceEntry(block.sourceType).delta.changed += 1;
    } else {
      unchangedBlocks.push({
        source_type: block.sourceType,
        source_item_id: block.sourceItemId,
        content_block_id: block.contentBlockId,
        content_kind: block.blockKind,
        source_text_hash: newHash
      });
      sourceEntry(block.sourceType).delta.unchanged += 1;
    }
  }
  for (const block of input.productionBlocks) {
    const key = blockIdentityKey(block);
    if (canonicalByKey.has(key)) continue;
    removedBlocks.push({
      source_type: block.source_type,
      source_item_id: block.source_item_id,
      content_block_id: block.content_block_id,
      block_kind: block.block_kind,
      old_hash: block.source_text_hash,
      new_hash: null,
      reason: "missing_in_canonical"
    });
    removedItems.add(itemKey(block.source_type, block.source_item_id));
    sourceEntry(block.source_type).delta.removed += 1;
  }

  const sortBlocks = (blocks: DeltaPlanBlock[]) => blocks.sort((left, right) =>
    left.source_type.localeCompare(right.source_type)
    || left.source_item_id.localeCompare(right.source_item_id)
    || left.content_block_id.localeCompare(right.content_block_id));

  const canonicalItems = new Set(input.canonicalBlocks.map((block) => itemKey(block.sourceType, block.sourceItemId)));
  return {
    version: "lexical-incremental-delta-plan-v1",
    production_baseline: input.productionBaseline,
    canonical_current: {
      items: Object.fromEntries(sourceTypes.map((sourceType) =>
        [sourceType, sourceEntry(sourceType).canonical.items.size])),
      blocks: Object.fromEntries(sourceTypes.map((sourceType) =>
        [sourceType, sourceEntry(sourceType).canonical.blocks])),
      total_items: canonicalItems.size,
      total_blocks: input.canonicalBlocks.length
    },
    per_source_counts: Object.fromEntries(sourceTypes.map((sourceType) => {
      const entry = sourceEntry(sourceType);
      return [sourceType, {
        production: { items: entry.production.items.size, blocks: entry.production.blocks },
        canonical: { items: entry.canonical.items.size, blocks: entry.canonical.blocks },
        delta: entry.delta
      }];
    })),
    delta_items: {
      new: Array.from(newItems).sort(),
      changed: Array.from(changedItems).sort(),
      removed: Array.from(removedItems).sort()
    },
    new_blocks: sortBlocks(newBlocks),
    changed_blocks: sortBlocks(changedBlocks),
    removed_blocks: sortBlocks(removedBlocks),
    unchanged_blocks: unchangedBlocks.sort((left, right) =>
      left.source_type.localeCompare(right.source_type)
      || left.source_item_id.localeCompare(right.source_item_id)
      || left.content_block_id.localeCompare(right.content_block_id))
  };
}

/** The canonical RAP title contract is one stable block per passage; bypassing the enumerator must fail closed. */
export function assertRapTitleCoverage(canonicalBlocks: CanonicalLexicalBlock[]) {
  const rapItems = new Map<string, { titleBlocks: number }>();
  for (const block of canonicalBlocks) {
    if (block.sourceType !== "rap") continue;
    const entry = rapItems.get(block.sourceItemId) ?? { titleBlocks: 0 };
    if (block.blockKind === "rap_title") entry.titleBlocks += 1;
    rapItems.set(block.sourceItemId, entry);
  }
  Array.from(rapItems).forEach(([sourceItemId, entry]) => {
    if (entry.titleBlocks !== 1) {
      throw new Error(`RAP source ${sourceItemId} must expose exactly one rap_title block; found ${entry.titleBlocks}.`);
    }
  });
}
