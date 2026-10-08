import { baselineRowsSha256 } from "./baselineHash.ts";
import { blockIdentityKey, sortBlocks, sortEntries, sortOccurrences, type ProductionBlockRow, type ProductionEntryRow, type ProductionOccurrenceRow } from "./productionBaseline.server.ts";
import type { IncrementalImportDataset } from "./importer.ts";

export type FullProductionSnapshot = {
  blocks: ProductionBlockRow[];
  entries: ProductionEntryRow[];
  occurrences: ProductionOccurrenceRow[];
};

export function fullSnapshotHashes(snapshot: FullProductionSnapshot) {
  return {
    blocks_sha256: baselineRowsSha256(sortBlocks(snapshot.blocks)),
    entries_sha256: baselineRowsSha256(sortEntries(snapshot.entries)),
    occurrences_sha256: baselineRowsSha256(sortOccurrences(snapshot.occurrences))
  };
}

/** Bind exact pre-state and unrelated full-row hashes; does not mutate any input. */
export function bindImportBaseline(data: IncrementalImportDataset, snapshot: FullProductionSnapshot): IncrementalImportDataset {
  const dataKey = (row: Record<string, any>) => `${row.source_type}:${row.source_item_id}:${row.content_block_id}`;
  const deltaKeys = new Set(data.delta.map(dataKey));
  const newEntryIds = new Set(data.entries.map((row) => row.entry_id));
  const blockByKey = new Map(snapshot.blocks.map((row) => [blockIdentityKey(row), row]));
  const occurrencesByBlock = new Map<string, ProductionOccurrenceRow[]>();
  for (const row of sortOccurrences(snapshot.occurrences)) {
    const key = blockIdentityKey(row);
    const rows = occurrencesByBlock.get(key) ?? [];
    rows.push(row);
    occurrencesByBlock.set(key, rows);
  }
  return {
    ...data,
    blocks: data.blocks.map((row) => ({ ...row, block_id: blockByKey.get(dataKey(row))?.block_id ?? row.block_id })),
    delta: data.delta.map((row) => {
      const key = dataKey(row);
      const oldBlock = blockByKey.get(key);
      if ((row.action === "new") === Boolean(oldBlock)) throw new Error(`Delta pre-state does not match action: ${key}.`);
      return {
        ...row,
        old_block_snapshot_sha256: oldBlock ? baselineRowsSha256([oldBlock]) : null,
        old_occurrences_snapshot_sha256: baselineRowsSha256(occurrencesByBlock.get(key) ?? [])
      };
    }),
    meta: {
      ...data.meta,
      unrelated_blocks_sha256: baselineRowsSha256(sortBlocks(snapshot.blocks.filter((row) => !deltaKeys.has(blockIdentityKey(row))))),
      entries_unrelated_sha256: baselineRowsSha256(sortEntries(snapshot.entries.filter((row) => !newEntryIds.has(row.entry_id)))),
      unrelated_occurrences_sha256: baselineRowsSha256(sortOccurrences(snapshot.occurrences.filter((row) => !deltaKeys.has(blockIdentityKey(row)))))
    }
  };
}
