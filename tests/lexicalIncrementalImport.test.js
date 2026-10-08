const assert = require("node:assert/strict");
const test = require("node:test");

const { buildIncrementalImportSql, incrementalImportPlanDescription } = require("../lib/lexical/incremental/importer.ts");
const { assembleDeltaArtifacts } = require("../lib/lexical/incremental/assemble.ts");
const { buildDeltaPlan } = require("../lib/lexical/incremental/deltaPlan.ts");
const { consolidateIncrementalDelta } = require("../lib/lexical/incremental/consolidation.ts");
const { canonicalSourceTextHash } = require("../lib/lexical/hash.ts");
const { lexicalEntryKey } = require("../lib/lexical/generationTypes.ts");
const { productionId } = require("../lib/lexical/production.ts");

function fixtureDataset() {
  const sameBlock = { sourceType: "ctw", sourceItemId: "item-a", contentBlockId: "paragraph:p1", blockKind: "ctw_paragraph", text: "Same text." };
  const changedBlock = { sourceType: "ctw", sourceItemId: "item-a", contentBlockId: "paragraph:p2", blockKind: "ctw_paragraph", text: "New text." };
  const newBlock = { sourceType: "ctw", sourceItemId: "item-b", contentBlockId: "paragraph:p1", blockKind: "ctw_paragraph", text: "Fresh text." };
  const removedBlock = { sourceType: "ctw", sourceItemId: "item-c", contentBlockId: "paragraph:p9", blockKind: "ctw_paragraph", text: "Gone text." };
  const prodBlock = (block, text) => ({
    block_id: productionId("block", JSON.stringify([block.sourceType, block.sourceItemId, block.contentBlockId])),
    source_type: block.sourceType, source_item_id: block.sourceItemId, content_block_id: block.contentBlockId,
    block_kind: block.blockKind, source_text_hash: canonicalSourceTextHash(text),
    generation_status: "generated", generation_version: "lexical-v1", last_error: null
  });
  const plan = buildDeltaPlan({
    canonicalBlocks: [sameBlock, changedBlock, newBlock],
    productionBlocks: [prodBlock(sameBlock, sameBlock.text), prodBlock(changedBlock, "Old text."), prodBlock(removedBlock, removedBlock.text)],
    productionBaseline: { counts: { entries: 1, blocks: 3, occurrences: 2 } }
  });
  const deltaOccurrence = {
    entry_key: lexicalEntryKey("fresh", "word"), source_type: "ctw", source_item_id: "item-b", content_block_id: "paragraph:p1",
    sentence_id: null, source_anchor_id: null, surface_text: "Fresh", normalized_surface: "fresh",
    start_offset: 0, end_offset: 5, context_pos: "adjective", context_meaning_zh: "新鲜的", context_definition_en: "Newly made.",
    context_text: "Fresh text.", review_status: "generated", generation_version: "lexical-v1", review_notes: null,
    layer: 1, expression_type: "word", canonical_expression: "fresh", normalized_expression: "fresh", lemma: "fresh"
  };
  const consolidation = consolidateIncrementalDelta({ occurrences: [deltaOccurrence], productionEntries: [] });
  const liveOccurrences = [{
    occurrence_id: productionId("occurrence", "ctw:item-a:paragraph:p2:0:3"), entry_id: "entry-x",
    source_type: "ctw", source_item_id: "item-a", content_block_id: "paragraph:p2", sentence_id: null, source_anchor_id: null,
    surface_text: "Old", normalized_surface: "old", start_offset: 0, end_offset: 3, context_pos: "noun",
    context_meaning_zh: "旧", context_definition_en: "Old.", review_status: "generated", generation_version: "lexical-v1", review_notes: null
  }];
  const assembled = assembleDeltaArtifacts({
    plan, consolidation, baselineCounts: { entries: 1, blocks: 3, occurrences: 2 },
    unrelated: { blocks_sha256: "b".repeat(64), occurrences_sha256: "a".repeat(64) },
    entriesUnrelatedSha256: "e".repeat(64), liveOccurrences
  });
  return {
    entries: assembled.entryRows, blocks: assembled.blockRows, occurrences: assembled.occurrenceRows,
    removed: assembled.removedRows, delta: assembled.deltaRows.map(row => ({ ...row, old_block_snapshot_sha256: row.action==='new'?null:"a".repeat(64), old_occurrences_snapshot_sha256: "a".repeat(64) })), meta: assembled.meta,
    entryColumns: assembled.columns.entryColumns, blockColumns: assembled.columns.blockColumns,
    occurrenceColumns: assembled.columns.occurrenceColumns
  };
}

test("incremental import is one fail-closed transaction with an advisory lock", () => {
  const sql = buildIncrementalImportSql(fixtureDataset());
  assert.ok(sql.startsWith("\\set ON_ERROR_STOP on\nBEGIN;\n"));
  assert.ok(sql.trimEnd().endsWith("COMMIT;"));
  assert.equal((sql.match(/(^|\n)BEGIN;/g) ?? []).length, 1);
  assert.equal((sql.match(/(^|\n)COMMIT;/g) ?? []).length, 1);
  assert.equal((sql.match(/pg_advisory_xact_lock\(7631043\)/g) ?? []).length, 1);
  assert.doesNotMatch(sql, /TRUNCATE|DROP TABLE public|ALTER TABLE public\.lexical_(entries|occurrences|source_blocks) (?!ADD COLUMN IF NOT EXISTS)/);
});

test("baseline drift gate recomputes the unrelated hashes before and after mutation", () => {
  const sql = buildIncrementalImportSql(fixtureDataset());
  assert.equal((sql.match(/Unrelated production blocks changed since delta generation/g) ?? []).length, 1);
  assert.equal((sql.match(/Unrelated production entries changed since delta generation/g) ?? []).length, 1);
  assert.equal((sql.match(/Unrelated production occurrences changed since delta generation/g) ?? []).length, 1);
  assert.equal((sql.match(/Unrelated blocks were modified by the import/g) ?? []).length, 1);
  assert.equal((sql.match(/Unrelated entries were modified by the import/g) ?? []).length, 1);
  assert.equal((sql.match(/Unrelated occurrences were modified by the import/g) ?? []).length, 1);
  // Both the before-gate and the after-gate must exist for each baseline hash.
  for (const key of ["unrelated_blocks_sha256", "entries_unrelated_sha256", "unrelated_occurrences_sha256"]) {
    assert.equal((sql.match(new RegExp(`'${key}'`, "g")) ?? []).length, 2);
  }
});

test("fresh/applied classification aborts on drift or mixed state instead of reconciling", () => {
  const sql = buildIncrementalImportSql(fixtureDataset());
  assert.match(sql, /WHEN b\.source_text_hash = d\.old_hash THEN 'fresh'/);
  assert.match(sql, /WHEN b\.source_text_hash = d\.new_hash THEN 'applied'/);
  assert.match(sql, /ELSE 'drift'/);
  assert.match(sql, /Incremental import baseline drift/);
  assert.match(sql, /Mixed applied\/fresh delta block state; automatic reconciliation is refused/);
  assert.match(sql, /Mixed applied\/fresh new-entry state; automatic reconciliation is refused/);
  // classification must happen before any mutation
  assert.ok(sql.indexOf("CREATE TEMP TABLE delta_state ON COMMIT DROP") < sql.indexOf("DELETE FROM public.lexical_occurrences"));
});

test("every mutation is gated to fresh state and scoped to exact delta identities", () => {
  const sql = buildIncrementalImportSql(fixtureDataset());
  const occurrenceDelete = sql.slice(sql.indexOf("DELETE FROM public.lexical_occurrences"), sql.indexOf("DELETE FROM public.lexical_source_blocks"));
  assert.match(occurrenceDelete, /USING delta_state s/);
  assert.match(occurrenceDelete, /s\.state = 'fresh'/);
  assert.match(occurrenceDelete, /\(o\.source_type, o\.source_item_id, o\.content_block_id\) = \(s\.source_type, s\.source_item_id, s\.content_block_id\)/);
  const blockDelete = sql.slice(sql.indexOf("DELETE FROM public.lexical_source_blocks"), sql.indexOf("UPDATE public.lexical_source_blocks"));
  assert.match(blockDelete, /s\.action = 'removed'/);
  assert.match(blockDelete, /s\.state = 'fresh'/);
  const blockUpdate = sql.slice(sql.indexOf("UPDATE public.lexical_source_blocks"), sql.indexOf("INSERT INTO public.lexical_entries"));
  assert.match(blockUpdate, /s\.action = 'changed'/);
  assert.match(blockUpdate, /s\.state = 'fresh'/);
  assert.ok((sql.match(/state = 'fresh'/g) ?? []).length >= 5);
});

test("entries are inserted only and never updated or deleted by the importer", () => {
  const sql = buildIncrementalImportSql(fixtureDataset());
  assert.doesNotMatch(sql, /UPDATE public\.lexical_entries/);
  assert.doesNotMatch(sql, /DELETE FROM public\.lexical_entries/);
  assert.equal((sql.match(/INSERT INTO public\.lexical_entries/g) ?? []).length, 1);
  assert.match(sql, /INSERT INTO public\.lexical_entries \([\s\S]*?\)\s*SELECT [\s\S]*? FROM stage_entries\nWHERE EXISTS \(SELECT 1 FROM delta_state WHERE state = 'fresh'\)\nON CONFLICT DO NOTHING/);
  assert.equal((sql.match(/ON CONFLICT DO NOTHING/g) ?? []).length, 3);
});

test("post verification fails closed on missing/extra occurrences, entries, orphans and counts", () => {
  const sql = buildIncrementalImportSql(fixtureDataset());
  for (const message of ["Delta source blocks are missing or inconsistent after import", "Removed blocks still present after import",
    "Delta occurrences missing after import", "Unexpected extra delta occurrences after import", "New entries missing after import",
    "New entry identity exists with different content", "Orphan occurrences appeared during import",
    "Occurrences without source blocks appeared during import", "Entry count mismatch after import",
    "Source block count mismatch after import", "Occurrence count mismatch after import"]) {
    assert.ok(sql.includes(message), `missing post-check: ${message}`);
  }
  assert.ok(sql.indexOf("EXCEPT SELECT") > sql.indexOf("-- Post verification"));
});

test("dry-run description reports the planned writes without touching the database", () => {
  const dataset = fixtureDataset();
  const description = incrementalImportPlanDescription(dataset);
  assert.equal(description.dry_run, true);
  assert.equal(description.new_entries, 1);
  assert.equal(description.new_blocks, 1);
  assert.equal(description.changed_blocks, 1);
  assert.equal(description.removed_blocks, 1);
  assert.equal(description.delta_occurrences, 1);
  assert.equal(description.unchanged_blocks_touched, 0);
  assert.equal(description.final_occurrences_count, Number(dataset.meta.final_occurrences_count));
  assert.equal(description.final_blocks_count, Number(dataset.meta.final_blocks_count));
  assert.equal(description.final_entries_count, Number(dataset.meta.final_entries_count));
});

test("meta final counts back a changed-block replacement exactly once", () => {
  const dataset = fixtureDataset();
  // 2 production occurrences - 1 replaced + 1 delta occurrence
  assert.equal(dataset.meta.final_occurrences_count, "2");
  assert.equal(dataset.meta.final_blocks_count, "3"); // 3 - 1 removed + 1 new
  assert.equal(dataset.meta.final_entries_count, "2"); // 1 + 1 new
  assert.equal(dataset.meta.reused_entries, "0");
});
