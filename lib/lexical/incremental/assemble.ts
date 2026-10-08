import { productionId, BLOCK_COLUMNS, ENTRY_COLUMNS, OCCURRENCE_COLUMNS } from "../production.ts";
import { LEXICAL_GENERATION_VERSION } from "../generationTypes.ts";
import { deltaEntryRow, deltaOccurrenceRow, occurrenceIdentityOf, type DeltaConsolidation } from "./consolidation.ts";
import type { DeltaPlan } from "./deltaPlan.ts";
import { blockIdentityKey, type ProductionOccurrenceRow } from "./productionBaseline.server.ts";

type DeltaPlanArtifact = DeltaPlan;

/**
 * Pure assembly of the incremental import dataset from a delta plan and its consolidation.
 * Never contains an unchanged block identity; changed blocks carry their deterministic block id,
 * so the importer can update exactly that row and delete exactly its own occurrences.
 */
export function assembleDeltaArtifacts(input: {
  plan: DeltaPlanArtifact;
  consolidation: DeltaConsolidation;
  baselineCounts: { entries: number; blocks: number; occurrences: number };
  unrelated: { blocks_sha256: string; occurrences_sha256: string };
  entriesUnrelatedSha256: string;
  liveOccurrences: ProductionOccurrenceRow[];
}) {
  const deltaBlocks = input.plan.new_blocks.concat(input.plan.changed_blocks);
  const artifactBlockKeys = deltaBlocks.map((block) =>
    `${block.source_type}:${block.source_item_id}:${block.content_block_id}`);
  const blockRows = deltaBlocks.map((block) => ({
    block_id: productionId("block", JSON.stringify([block.source_type, block.source_item_id, block.content_block_id])),
    source_type: block.source_type,
    source_item_id: block.source_item_id,
    content_block_id: block.content_block_id,
    block_kind: block.block_kind,
    source_text_hash: block.new_hash,
    generation_status: "generated",
    generation_version: LEXICAL_GENERATION_VERSION,
    last_error: null as string | null
  }));
  const occurrenceRows = input.consolidation.occurrences.map((occurrence) => {
    const identity = occurrenceIdentityOf(occurrence);
    const assignment = input.consolidation.assignments.get(identity);
    if (!assignment) throw new Error(`Occurrence ${identity} has no entry assignment.`);
    return deltaOccurrenceRow(occurrence, assignment.entry_id);
  });
  const entryRows = input.consolidation.newEntries.map(deltaEntryRow);
  const removedRows = input.plan.removed_blocks.map((block) => ({
    source_type: block.source_type,
    source_item_id: block.source_item_id,
    content_block_id: block.content_block_id,
    block_kind: block.block_kind,
    old_hash: block.old_hash
  }));
  const mappingRows = occurrenceRows.map((row) => {
    const identity = occurrenceIdentityOf(row);
    const assignment = input.consolidation.assignments.get(identity)!;
    return {
      source_occurrence_id: identity,
      entry_key: assignment.entry_key,
      entry_id: assignment.entry_id,
      reused_production_entry: assignment.reused,
      mapping_status: "consolidated"
    };
  });
  const removedKeySet = new Set(input.plan.removed_blocks.map((block) =>
    `${block.source_type}:${block.source_item_id}:${block.content_block_id}`));
  const oldOccurrencesOfDeltaBlocks = input.liveOccurrences.filter((occurrence) => {
    const key = blockIdentityKey(occurrence);
    return artifactBlockKeys.includes(key) || removedKeySet.has(key);
  }).length;
  const meta: Record<string, string> = {
    unrelated_blocks_sha256: input.unrelated.blocks_sha256,
    entries_unrelated_sha256: input.entriesUnrelatedSha256,
    unrelated_occurrences_sha256: input.unrelated.occurrences_sha256,
    reused_entries: String(input.consolidation.reusedEntries.length),
    final_entries_count: String(input.baselineCounts.entries + entryRows.length),
    final_blocks_count: String(input.baselineCounts.blocks + input.plan.new_blocks.length - input.plan.removed_blocks.length),
    final_occurrences_count: String(input.baselineCounts.occurrences + occurrenceRows.length - oldOccurrencesOfDeltaBlocks)
  };
  const deltaRows = input.plan.new_blocks.map((block) => ({ ...block, action: "new" })).concat(
    input.plan.changed_blocks.map((block) => ({ ...block, action: "changed" })),
    input.plan.removed_blocks.map((block) => ({ ...block, action: "removed" })));
  return {
    blockRows,
    occurrenceRows,
    entryRows,
    removedRows,
    mappingRows,
    deltaRows,
    meta,
    artifactBlockKeys,
    columns: {
      entryColumns: [...ENTRY_COLUMNS],
      blockColumns: [...BLOCK_COLUMNS],
      occurrenceColumns: [...OCCURRENCE_COLUMNS]
    }
  };
}
