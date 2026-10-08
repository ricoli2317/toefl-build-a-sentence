import { baselineValue, baselineRowsSha256 } from "./baselineHash.ts";
import { bindImportBaseline, fullSnapshotHashes, type FullProductionSnapshot } from "./importBaseline.ts";
import type { IncrementalImportDataset } from "./importer.ts";
import { blockIdentityKey, sortBlocks, sortEntries, sortOccurrences } from "./productionBaseline.server.ts";

/** Read-only advisory preflight; the transaction repeats every safety gate under table locks. */
export function preflightIncrementalImport(data: IncrementalImportDataset, before: FullProductionSnapshot, live: FullProductionSnapshot) {
  const byKey = new Map(live.blocks.map(row => [blockIdentityKey(row), row]));
  const keyOf = (row: Record<string, any>) => `${row.source_type}:${row.source_item_id}:${row.content_block_id}`;
  const states = data.delta.map(row => {
    const current = byKey.get(keyOf(row));
    if (row.action === "removed") return !current ? "applied" : current.source_text_hash === row.old_hash ? "fresh" : "drift";
    if (!current) return row.action === "new" ? "fresh" : "drift";
    return current.source_text_hash === row.old_hash ? "fresh" : current.source_text_hash === row.new_hash ? "applied" : "drift";
  });
  if (states.includes("drift") || (states.includes("fresh") && states.includes("applied"))) throw new Error("Read-only import preflight detected baseline drift or a mixed partial import.");
  if (!states.length || states.includes("fresh")) {
    if (JSON.stringify(fullSnapshotHashes(before)) !== JSON.stringify(fullSnapshotHashes(live))) throw new Error("Read-only import preflight: production baseline drift.");
    return { state: states.length ? "fresh" : "no_delta", compatible: true, production_writes: 0 };
  }

  const deltaKeys = new Set(data.delta.map(keyOf));
  const entryIds = new Set(data.entries.map(row => row.entry_id));
  const bound = bindImportBaseline(data, before);
  const unchanged = {
    unrelated_blocks_sha256: baselineRowsSha256(sortBlocks(live.blocks.filter(row => !deltaKeys.has(blockIdentityKey(row))))),
    entries_unrelated_sha256: baselineRowsSha256(sortEntries(live.entries.filter(row => !entryIds.has(row.entry_id)))),
    unrelated_occurrences_sha256: baselineRowsSha256(sortOccurrences(live.occurrences.filter(row => !deltaKeys.has(blockIdentityKey(row)))))
  };
  for (const [key, value] of Object.entries(unchanged)) if (value !== bound.meta[key]) throw new Error(`Read-only import preflight: applied import has unrelated drift (${key}).`);
  const projection = (row: Record<string, any>, columns: string[]) => baselineValue(Object.fromEntries(columns.map(column => [column, row[column]])));
  const equalSets = (expected: Record<string, any>[], actual: Record<string, any>[], columns: string[]) => {
    const left = expected.map(row => projection(row, columns)).sort();
    const right = actual.map(row => projection(row, columns)).sort();
    return JSON.stringify(left) === JSON.stringify(right);
  };
  if (!equalSets(data.entries, live.entries.filter(row => entryIds.has(row.entry_id)), data.entryColumns)
    || !equalSets(data.blocks, live.blocks.filter(row => deltaKeys.has(blockIdentityKey(row))), data.blockColumns)
    || !equalSets(data.occurrences, live.occurrences.filter(row => deltaKeys.has(blockIdentityKey(row))), data.occurrenceColumns)
    || live.entries.length !== Number(data.meta.final_entries_count)
    || live.blocks.length !== Number(data.meta.final_blocks_count)
    || live.occurrences.length !== Number(data.meta.final_occurrences_count)) throw new Error("Read-only import preflight: applied rows do not equal the complete staged post-state.");
  return { state: "applied", compatible: true, production_writes: 0 };
}
