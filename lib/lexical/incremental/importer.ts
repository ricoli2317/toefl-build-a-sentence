import { BASELINE_HASH_SQL, baselineRowsHashSql } from "./baselineHash.ts";
import { BLOCK_COLUMNS, ENTRY_COLUMNS, OCCURRENCE_COLUMNS } from "../production.ts";

type Row = Record<string, any>;

/** CSV cell quoting identical to the historical production importer. */
function csvCell(value: unknown) {
  return value == null ? "" : `"${(typeof value === "object" ? JSON.stringify(value) : String(value)).replace(/"/g, '""')}"`;
}

function copySql(table: string, columns: string[], rows: Row[]) {
  const header = `COPY ${table} (${columns.join(",")}) FROM STDIN WITH (FORMAT csv);\n`;
  const body = rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")).join("\n");
  return `${header}${rows.length ? `${body}\n` : ""}\\.\n`;
}

function stageTableSql(table: string, columns: string[], rows: Row[]) {
  const definitions: Record<string, string> = {
    meta: "key text PRIMARY KEY, value text NOT NULL",
    delta: "source_type text NOT NULL, source_item_id text NOT NULL, content_block_id text NOT NULL, action text NOT NULL CHECK (action IN ('new','changed','removed')), old_hash text, new_hash text, block_kind text NOT NULL, old_block_snapshot_sha256 text, old_occurrences_snapshot_sha256 text NOT NULL, PRIMARY KEY (source_type,source_item_id,content_block_id)",
    removed: "source_type text NOT NULL, source_item_id text NOT NULL, content_block_id text NOT NULL, block_kind text NOT NULL, old_hash text NOT NULL, PRIMARY KEY (source_type,source_item_id,content_block_id)",
    entries: "LIKE public.lexical_entries INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES",
    blocks: "LIKE public.lexical_source_blocks INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES",
    occurrences: "LIKE public.lexical_occurrences INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES"
  };
  if (!definitions[table]) throw new Error(`Unknown incremental staging table ${table}.`);
  return `CREATE TEMP TABLE stage_${table} (${definitions[table]}) ON COMMIT DROP;\n`
    + copySql(`stage_${table}`, columns, rows);
}

const DELTA_COLUMNS = ["source_type", "source_item_id", "content_block_id", "action", "old_hash", "new_hash", "block_kind", "old_block_snapshot_sha256", "old_occurrences_snapshot_sha256"];
const REMOVED_COLUMNS = ["source_type", "source_item_id", "content_block_id", "block_kind", "old_hash"];

const blockUnrelatedHashSql = baselineRowsHashSql("public.lexical_source_blocks", "b",
  'b.source_type COLLATE "C", b.source_item_id COLLATE "C", b.content_block_id COLLATE "C"',
  `NOT EXISTS (SELECT 1 FROM stage_delta d
  WHERE d.source_type = b.source_type AND d.source_item_id = b.source_item_id AND d.content_block_id = b.content_block_id)`);

const entryUnrelatedHashSql = (staged: string) => baselineRowsHashSql("public.lexical_entries", "e",
  'e.normalized_expression COLLATE "C", e.expression_type COLLATE "C", e.identity_variant COLLATE "C"',
  `NOT EXISTS (SELECT 1 FROM ${staged} s WHERE s.entry_id = e.entry_id)`);

const occurrenceOrder = 'o.source_type COLLATE "C", o.source_item_id COLLATE "C", o.content_block_id COLLATE "C", o.start_offset, o.end_offset, o.occurrence_id';
const occurrenceUnrelatedHashSql = baselineRowsHashSql("public.lexical_occurrences", "o", occurrenceOrder,
  `NOT EXISTS (SELECT 1 FROM stage_delta d
  WHERE d.source_type = o.source_type AND d.source_item_id = o.source_item_id AND d.content_block_id = o.content_block_id)`);

export type IncrementalImportDataset = {
  entries: Row[];
  blocks: Row[];
  occurrences: Row[];
  removed: Row[];
  delta: Row[];
  meta: Record<string, string>;
  entryColumns: string[];
  blockColumns: string[];
  occurrenceColumns: string[];
};

/**
 * Deterministic single-transaction incremental import. State classification (fresh vs already
 * applied) happens inside the transaction; anything else aborts and rolls back. Unchanged rows are
 * never targeted; their identity hashes are recomputed before and after to prove zero writes.
 */
export function buildIncrementalImportSql(data: IncrementalImportDataset) {
  for (const [actual, expected] of [[data.entryColumns, ENTRY_COLUMNS], [data.blockColumns, BLOCK_COLUMNS], [data.occurrenceColumns, OCCURRENCE_COLUMNS]]) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Incremental import column contract mismatch.");
  }
  for (const key of ["unrelated_blocks_sha256", "entries_unrelated_sha256", "unrelated_occurrences_sha256"]) {
    if (!/^[a-f0-9]{64}$/.test(data.meta[key] ?? "")) throw new Error(`Missing full SHA-256 baseline ${key}.`);
  }
  for (const key of ["final_entries_count", "final_blocks_count", "final_occurrences_count"]) {
    if (!/^\d+$/.test(data.meta[key] ?? "")) throw new Error(`Invalid import count ${key}.`);
  }
  for (const row of data.delta) {
    if (!/^[a-f0-9]{64}$/.test(row.old_occurrences_snapshot_sha256 ?? "")
      || (row.action !== "new" && !/^[a-f0-9]{64}$/.test(row.old_block_snapshot_sha256 ?? ""))) {
      throw new Error("Delta is missing its exact pre-state SHA-256 snapshot.");
    }
  }
  const blockKey = (row: Row) => JSON.stringify([row.source_type, row.source_item_id, row.content_block_id]);
  const deltaByKey = new Map(data.delta.map(row => [blockKey(row), row]));
  if (deltaByKey.size !== data.delta.length) throw new Error("Duplicate staged delta identity.");
  const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  for (const row of data.delta) {
    const valid = row.action === "new" ? row.old_hash == null && row.old_block_snapshot_sha256 == null && hash(row.new_hash)
      : row.action === "changed" ? hash(row.old_hash) && hash(row.new_hash) && row.old_hash !== row.new_hash
      : row.action === "removed" && hash(row.old_hash) && row.new_hash == null;
    if (!valid) throw new Error("Invalid staged delta action/hash contract.");
  }
  const assertBlockSet = (rows: Row[], removed: boolean) => {
    const expected = data.delta.filter(row => (row.action === "removed") === removed);
    if (rows.length !== expected.length || new Set(rows.map(blockKey)).size !== rows.length) throw new Error("Staged block/removal set differs from exact delta.");
    for (const row of rows) {
      const delta = deltaByKey.get(blockKey(row));
      if (!delta || (delta.action === "removed") !== removed || row.block_kind !== delta.block_kind
        || (removed ? row.old_hash !== delta.old_hash : row.source_text_hash !== delta.new_hash)) throw new Error("Staged block/removal content differs from delta.");
    }
  };
  assertBlockSet(data.blocks, false);
  assertBlockSet(data.removed, true);
  const occurrenceSpans = new Set<string>();
  for (const row of data.occurrences) {
    const delta = deltaByKey.get(blockKey(row));
    const span = `${blockKey(row)}:${row.start_offset}:${row.end_offset}`;
    if (!delta || delta.action === "removed" || occurrenceSpans.has(span)
      || !Number.isInteger(row.start_offset) || !Number.isInteger(row.end_offset) || row.start_offset < 0 || row.end_offset <= row.start_offset) throw new Error("Invalid or duplicate staged occurrence outside exact delta.");
    occurrenceSpans.add(span);
  }
  const metaRows = Object.entries(data.meta).map(([key, value]) => ({ key, value }));
  let sql = `\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';
SET LOCAL timezone = 'UTC';
SELECT pg_advisory_xact_lock(7631043);
LOCK TABLE public.lexical_entries, public.lexical_source_blocks, public.lexical_occurrences IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE required record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'lexical_entries' AND column_name = 'identity_variant') THEN
    RAISE EXCEPTION 'Production lexical schema is missing identity_variant';
  END IF;
  FOR required IN SELECT * FROM (VALUES
    ('lexical_entries','entry_id'), ('lexical_entries','normalized_expression,expression_type,identity_variant'),
    ('lexical_source_blocks','block_id'), ('lexical_source_blocks','source_type,source_item_id,content_block_id'),
    ('lexical_occurrences','occurrence_id'), ('lexical_occurrences','source_type,source_item_id,content_block_id,start_offset,end_offset')
  ) AS keys(table_name,column_names) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace ns ON ns.oid = t.relnamespace
      WHERE ns.nspname = 'public' AND t.relname = required.table_name AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
        AND (SELECT string_agg(a.attname, ',' ORDER BY k.ordinality)
          FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
          WHERE k.ordinality <= i.indnkeyatts) = required.column_names) THEN
      RAISE EXCEPTION 'Production lexical schema lacks required unique index: % (%)', required.table_name, required.column_names;
    END IF;
  END LOOP;
END $$;
`;
  sql += stageTableSql("meta", ["key", "value"], metaRows);
  sql += stageTableSql("delta", DELTA_COLUMNS, data.delta);
  sql += stageTableSql("removed", REMOVED_COLUMNS, data.removed);
  sql += stageTableSql("entries", data.entryColumns, data.entries);
  sql += stageTableSql("blocks", data.blockColumns, data.blocks);
  sql += stageTableSql("occurrences", data.occurrenceColumns, data.occurrences);
  sql += BASELINE_HASH_SQL;

  sql += `
CREATE TEMP TABLE delta_state ON COMMIT DROP AS
SELECT d.*,
  (SELECT count(*) FROM public.lexical_occurrences o
    WHERE o.source_type = d.source_type AND o.source_item_id = d.source_item_id AND o.content_block_id = d.content_block_id) AS old_occurrence_count,
  CASE
    WHEN d.action = 'removed' THEN
      CASE WHEN b.block_id IS NULL THEN 'applied'
           WHEN b.source_text_hash = d.old_hash THEN 'fresh'
           ELSE 'drift' END
    WHEN b.block_id IS NULL THEN
      CASE WHEN d.action = 'new' THEN 'fresh' ELSE 'drift' END
    WHEN b.source_text_hash = d.old_hash THEN 'fresh'
    WHEN b.source_text_hash = d.new_hash THEN 'applied'
    ELSE 'drift'
  END AS state
FROM stage_delta d
LEFT JOIN public.lexical_source_blocks b
  ON b.source_type = d.source_type AND b.source_item_id = d.source_item_id AND b.content_block_id = d.content_block_id;
`;

  sql += `
DO $$
DECLARE fresh bigint; applied bigint; drifted bigint; present_entries bigint; absent_entries bigint; actual text; expected text;
BEGIN
  SELECT count(*) FILTER (WHERE state = 'fresh'), count(*) FILTER (WHERE state = 'applied'), count(*) FILTER (WHERE state = 'drift')
    INTO fresh, applied, drifted FROM delta_state;
  IF drifted > 0 THEN RAISE EXCEPTION 'Incremental import baseline drift: % delta block(s) are in an unexpected state', drifted; END IF;
  IF fresh > 0 AND applied > 0 THEN RAISE EXCEPTION 'Mixed applied/fresh delta block state; automatic reconciliation is refused'; END IF;
  SELECT count(*) FILTER (WHERE present), count(*) FILTER (WHERE NOT present)
    INTO present_entries, absent_entries
    FROM (SELECT EXISTS (SELECT 1 FROM public.lexical_entries e WHERE e.entry_id = s.entry_id) AS present FROM stage_entries s) t;
  IF present_entries > 0 AND absent_entries > 0 THEN RAISE EXCEPTION 'Mixed applied/fresh new-entry state; automatic reconciliation is refused'; END IF;
  IF present_entries > 0 AND applied = 0 THEN RAISE EXCEPTION 'New entries exist while delta blocks are fresh; refusing partial state'; END IF;
  IF absent_entries > 0 AND fresh = 0 THEN RAISE EXCEPTION 'New entries are absent while delta blocks are applied; refusing partial state'; END IF;

  IF EXISTS (SELECT 1 FROM delta_state d WHERE d.state = 'fresh' AND
    ((${baselineRowsHashSql("public.lexical_occurrences", "o", occurrenceOrder,
      "(o.source_type,o.source_item_id,o.content_block_id) = (d.source_type,d.source_item_id,d.content_block_id)")}) IS DISTINCT FROM d.old_occurrences_snapshot_sha256
    OR (d.action <> 'new' AND (${baselineRowsHashSql("public.lexical_source_blocks", "b", "b.block_id",
      "(b.source_type,b.source_item_id,b.content_block_id) = (d.source_type,d.source_item_id,d.content_block_id)")}) IS DISTINCT FROM d.old_block_snapshot_sha256))) THEN
    RAISE EXCEPTION 'Exact delta pre-state changed since generation';
  END IF;

  SELECT (${blockUnrelatedHashSql}) INTO actual;
  SELECT value INTO expected FROM stage_meta WHERE key = 'unrelated_blocks_sha256';
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Unrelated production blocks changed since delta generation'; END IF;

  SELECT (${entryUnrelatedHashSql("stage_entries")}) INTO actual;
  SELECT value INTO expected FROM stage_meta WHERE key = 'entries_unrelated_sha256';
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Unrelated production entries changed since delta generation'; END IF;

  SELECT (${occurrenceUnrelatedHashSql}) INTO actual;
  SELECT value INTO expected FROM stage_meta WHERE key = 'unrelated_occurrences_sha256';
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Unrelated production occurrences changed since delta generation'; END IF;
END $$;
`;

  sql += `
-- Apply. Every statement is gated to fresh delta state and touches only staged identities.
DELETE FROM public.lexical_occurrences o
USING delta_state s
WHERE s.state = 'fresh'
  AND (o.source_type, o.source_item_id, o.content_block_id) = (s.source_type, s.source_item_id, s.content_block_id);
DELETE FROM public.lexical_source_blocks b
USING delta_state s
WHERE s.state = 'fresh' AND s.action = 'removed'
  AND (b.source_type, b.source_item_id, b.content_block_id) = (s.source_type, s.source_item_id, s.content_block_id);
UPDATE public.lexical_source_blocks b
SET source_text_hash = st.source_text_hash, block_kind = st.block_kind, generation_status = st.generation_status,
    generation_version = st.generation_version, last_error = st.last_error, updated_at = now()
FROM stage_blocks st, delta_state s
WHERE s.state = 'fresh' AND s.action = 'changed'
  AND (st.source_type, st.source_item_id, st.content_block_id) = (s.source_type, s.source_item_id, s.content_block_id)
  AND (b.source_type, b.source_item_id, b.content_block_id) = (s.source_type, s.source_item_id, s.content_block_id);
INSERT INTO public.lexical_entries (${data.entryColumns.join(",")})
SELECT ${data.entryColumns.join(",")} FROM stage_entries
WHERE EXISTS (SELECT 1 FROM delta_state WHERE state = 'fresh')
ON CONFLICT DO NOTHING;
INSERT INTO public.lexical_source_blocks (${data.blockColumns.join(",")})
SELECT ${data.blockColumns.join(",")} FROM stage_blocks st
WHERE EXISTS (SELECT 1 FROM delta_state s WHERE s.state = 'fresh'
  AND s.action = 'new'
  AND (s.source_type, s.source_item_id, s.content_block_id) = (st.source_type, st.source_item_id, st.content_block_id))
ON CONFLICT DO NOTHING;
INSERT INTO public.lexical_occurrences (${data.occurrenceColumns.join(",")})
SELECT ${data.occurrenceColumns.join(",")} FROM stage_occurrences o
WHERE EXISTS (SELECT 1 FROM delta_state s WHERE s.state = 'fresh'
  AND (s.source_type, s.source_item_id, s.content_block_id) = (o.source_type, o.source_item_id, o.content_block_id))
ON CONFLICT DO NOTHING;
`;

  sql += `
-- Post verification for both fresh and already-applied runs.
DO $$
DECLARE actual text; expected text; missing bigint; extra bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM stage_blocks st
    LEFT JOIN public.lexical_source_blocks b
      ON (b.source_type, b.source_item_id, b.content_block_id) = (st.source_type, st.source_item_id, st.content_block_id)
    WHERE b.block_id IS NULL OR b.block_id IS DISTINCT FROM st.block_id OR b.source_text_hash IS DISTINCT FROM st.source_text_hash OR b.block_kind IS DISTINCT FROM st.block_kind
      OR b.generation_status IS DISTINCT FROM 'generated' OR b.generation_version IS DISTINCT FROM 'lexical-v1' OR b.last_error IS NOT NULL) THEN
    RAISE EXCEPTION 'Delta source blocks are missing or inconsistent after import';
  END IF;
  IF EXISTS (SELECT 1 FROM stage_removed r
    JOIN public.lexical_source_blocks b
      ON (b.source_type, b.source_item_id, b.content_block_id) = (r.source_type, r.source_item_id, r.content_block_id)) THEN
    RAISE EXCEPTION 'Removed blocks still present after import';
  END IF;
  SELECT count(*) INTO missing FROM (SELECT ${data.occurrenceColumns.join(",")} FROM stage_occurrences
    EXCEPT SELECT ${data.occurrenceColumns.join(",")} FROM public.lexical_occurrences o
      WHERE EXISTS (SELECT 1 FROM delta_state s
        WHERE (s.source_type, s.source_item_id, s.content_block_id) = (o.source_type, o.source_item_id, o.content_block_id))) d;
  IF missing > 0 THEN RAISE EXCEPTION 'Delta occurrences missing after import: %', missing; END IF;
  SELECT count(*) INTO extra FROM (SELECT ${data.occurrenceColumns.join(",")} FROM public.lexical_occurrences o
    WHERE EXISTS (SELECT 1 FROM delta_state s
      WHERE (s.source_type, s.source_item_id, s.content_block_id) = (o.source_type, o.source_item_id, o.content_block_id))
    EXCEPT SELECT ${data.occurrenceColumns.join(",")} FROM stage_occurrences) d;
  IF extra > 0 THEN RAISE EXCEPTION 'Unexpected extra delta occurrences after import: %', extra; END IF;
  IF EXISTS (SELECT ${data.entryColumns.join(",")} FROM stage_entries
    EXCEPT SELECT ${data.entryColumns.join(",")} FROM public.lexical_entries) THEN
    RAISE EXCEPTION 'New entries missing after import';
  END IF;
  IF EXISTS (SELECT ${data.entryColumns.join(",")} FROM public.lexical_entries e
    WHERE e.entry_id IN (SELECT entry_id FROM stage_entries)
    EXCEPT SELECT ${data.entryColumns.join(",")} FROM stage_entries) THEN
    RAISE EXCEPTION 'New entry identity exists with different content';
  END IF;
  IF (SELECT count(*) FROM public.lexical_occurrences o LEFT JOIN public.lexical_entries e USING (entry_id)
      WHERE e.entry_id IS NULL) <> 0 THEN
    RAISE EXCEPTION 'Orphan occurrences appeared during import';
  END IF;
  IF (SELECT count(*) FROM public.lexical_occurrences o LEFT JOIN public.lexical_source_blocks b
      USING (source_type, source_item_id, content_block_id) WHERE b.block_id IS NULL) <> 0 THEN
    RAISE EXCEPTION 'Occurrences without source blocks appeared during import';
  END IF;

  SELECT value INTO expected FROM stage_meta WHERE key = 'final_entries_count';
  IF (SELECT count(*) FROM public.lexical_entries) <> expected::bigint THEN
    RAISE EXCEPTION 'Entry count mismatch after import: expected %', expected;
  END IF;
  SELECT value INTO expected FROM stage_meta WHERE key = 'final_blocks_count';
  IF (SELECT count(*) FROM public.lexical_source_blocks) <> expected::bigint THEN
    RAISE EXCEPTION 'Source block count mismatch after import: expected %', expected;
  END IF;
  SELECT value INTO expected FROM stage_meta WHERE key = 'final_occurrences_count';
  IF (SELECT count(*) FROM public.lexical_occurrences) <> expected::bigint THEN
    RAISE EXCEPTION 'Occurrence count mismatch after import: expected %', expected;
  END IF;

  SELECT (${blockUnrelatedHashSql}) INTO actual;
  SELECT value INTO expected FROM stage_meta WHERE key = 'unrelated_blocks_sha256';
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Unrelated blocks were modified by the import'; END IF;
  SELECT (${entryUnrelatedHashSql("stage_entries")}) INTO actual;
  SELECT value INTO expected FROM stage_meta WHERE key = 'entries_unrelated_sha256';
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Unrelated entries were modified by the import'; END IF;
  SELECT (${occurrenceUnrelatedHashSql}) INTO actual;
  SELECT value INTO expected FROM stage_meta WHERE key = 'unrelated_occurrences_sha256';
  IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Unrelated occurrences were modified by the import'; END IF;
END $$;
COMMIT;
`;
  return sql;
}

export function incrementalImportPlanDescription(data: IncrementalImportDataset) {
  const newBlocks = data.delta.filter((row) => row.action === "new").length;
  const changedBlocks = data.delta.filter((row) => row.action === "changed").length;
  const removedBlocks = data.delta.filter((row) => row.action === "removed").length;
  return {
    dry_run: true,
    transaction: "single staged transaction with advisory lock and baseline compatibility gate",
    new_entries: data.entries.length,
    reused_entries: Number(data.meta.reused_entries ?? 0),
    new_blocks: newBlocks,
    changed_blocks: changedBlocks,
    removed_blocks: removedBlocks,
    delta_occurrences: data.occurrences.length,
    unchanged_blocks_touched: 0,
    final_entries_count: Number(data.meta.final_entries_count),
    final_blocks_count: Number(data.meta.final_blocks_count),
    final_occurrences_count: Number(data.meta.final_occurrences_count)
  };
}
