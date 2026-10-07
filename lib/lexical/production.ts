import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalSourceTextHash } from "./hash.ts";

type Row = Record<string, any>;
const SUCCESSOR = "tmp/lexical-v1/consolidation-resolved";
export const PRODUCTION_DIRECTORY = "tmp/lexical-v1/production";
export const ENTRY_COLUMNS = ["entry_id", "canonical_expression", "normalized_expression", "expression_type", "lemma",
  "common_senses", "derived_words", "useful_patterns", "review_status", "generation_version", "review_notes", "identity_variant"];
export const OCCURRENCE_COLUMNS = ["occurrence_id", "entry_id", "source_type", "source_item_id", "content_block_id",
  "sentence_id", "source_anchor_id", "surface_text", "normalized_surface", "start_offset", "end_offset", "context_pos",
  "context_meaning_zh", "context_definition_en", "context_text", "review_status", "generation_version", "review_notes"];
export const BLOCK_COLUMNS = ["block_id", "source_type", "source_item_id", "content_block_id", "block_kind", "source_text_hash",
  "generation_status", "generation_version", "last_error"];
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const parse = (v: string): Row[] => v.split("\n").filter(Boolean).map(v => JSON.parse(v));
const blockKey = (v: Row) => JSON.stringify([v.source_type, v.source_item_id, v.content_block_id]);
export const occurrenceIdentity = (v: Row) => `${v.source_type}:${v.source_item_id}:${v.content_block_id}:${v.start_offset}:${v.end_offset}`;
// Transport IDs are derived from the frozen identity; this never reconsolidates or changes entry keys.
export function productionId(kind: string, identity: string) {
  const h = sha(`tps:lexical-v1:${kind}:${identity}`).slice(0, 32).split("");
  h[12] = "5"; h[16] = "8";
  const s = h.join("");
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
const pick = (v: Row, columns: string[]) => Object.fromEntries(columns.map(k => [k, v[k] ?? null]));
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function utf16Boundary(text: string, offset: number) {
  return !(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]));
}

type ProductionInput = { entries: Row[]; mappings: Row[]; blocks: Row[]; exclusions: Row[]; removed: Row[] };
export function buildProductionDataset(input: ProductionInput) {
  assert(input.entries.length === 13043, "Expected 13043 entries");
  assert(input.mappings.length === 149411, "Expected 149411 publishable mappings");
  assert(input.exclusions.length === 1 && input.removed.length === 754, "Frozen exclusion counts changed");
  return validateProductionDataset(input);
}

/** Pure row conversion/validation, also exercised by small offline contract fixtures.
 * The production finalizer always uses buildProductionDataset's frozen-count gate.
 */
export function validateProductionDataset(input: ProductionInput) {
  const entriesByKey = new Map(input.entries.map(e => [e.entry_key, e]));
  assert(entriesByKey.size === input.entries.length, "Duplicate entry key");
  const blocks = new Map(input.blocks.map(b => [blockKey(b), b]));
  assert(blocks.size === input.blocks.length, "Duplicate canonical block");
  for (const b of input.blocks) assert(canonicalSourceTextHash(b.text) === b.source_text_hash, "Canonical block hash mismatch");
  const excluded = new Set(input.exclusions.map(e => e.source_occurrence_id));
  const removed = new Set(input.removed.map(e => occurrenceIdentity(e.original_value ?? e.original_occurrence ?? e)));
  const seen = new Set<string>();
  const entries = input.entries.map(e => pick({ ...e, entry_id: productionId("entry", e.entry_key), identity_variant: e.review_target_id ?? "" }, ENTRY_COLUMNS));
  assert(new Set(entries.map(e => JSON.stringify([e.normalized_expression, e.expression_type, e.identity_variant]))).size === entries.length,
    "Duplicate production entry identity");
  const occurrences = input.mappings.map(o => {
    const identity = occurrenceIdentity(o);
    assert(o.source_occurrence_id === identity && o.mapping_status === "consolidated", "Invalid mapping identity/status");
    assert(!seen.has(identity), "Duplicate occurrence identity"); seen.add(identity);
    assert(!excluded.has(identity), "Excluded invalid occurrence reappeared");
    assert(!removed.has(identity), "Removed MWE reappeared");
    assert(entriesByKey.has(o.consolidated_entry_key), "Missing entry mapping/orphan");
    const b = blocks.get(blockKey(o)); assert(b, "Missing canonical block");
    assert(Number.isInteger(o.start_offset) && Number.isInteger(o.end_offset) && o.start_offset >= 0 && o.end_offset > o.start_offset
      && o.end_offset <= b.text.length && utf16Boundary(b.text, o.start_offset) && utf16Boundary(b.text, o.end_offset), "Invalid UTF-16 offsets");
    assert(b.text.slice(o.start_offset, o.end_offset) === o.surface_text, "Exact slice mismatch");
    return pick({ ...o, occurrence_id: productionId("occurrence", identity), entry_id: productionId("entry", o.consolidated_entry_key) }, OCCURRENCE_COLUMNS);
  });
  const sourceBlocks = input.blocks.map(b => pick({ ...b, block_id: productionId("block", blockKey(b)),
    generation_status: "generated", generation_version: "lexical-v1", last_error: null }, BLOCK_COLUMNS));
  return { entries, occurrences, sourceBlocks, qa: { entries: entries.length, occurrences: occurrences.length, source_blocks: sourceBlocks.length,
    orphan_occurrence: 0, missing_entry_mapping: 0, duplicate_occurrence_identity: 0, missing_canonical_block: 0,
    invalid_utf16_offsets: 0, exact_slice_mismatch: 0, duplicate_entry_key: 0, excluded_invalid_reappearing: 0,
    removed_mwe_reappearing: 0, unresolved_consolidation_review: 0 } };
}

// COPY is client-to-server STDIN through psql, never a server-side file operation.
function copySql(table: string, columns: string[], rows: Row[]) {
  const cell = (v: unknown) => v == null ? "" : `"${(typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/"/g, '""')}"`;
  return `COPY ${table} (${columns.join(",")}) FROM STDIN WITH (FORMAT csv);\n` + rows.map(r => columns.map(k => cell(r[k])).join(",")).join("\n") + "\n\\.\n";
}
export function productionImportSql(data: ReturnType<typeof buildProductionDataset>, identityMigration: string) {
  let sql = `\\set ON_ERROR_STOP on\nBEGIN;\nSET LOCAL lock_timeout = '10s';\nSET LOCAL statement_timeout = '10min';\nSELECT pg_advisory_xact_lock(7631043);\n${identityMigration}\n`;
  const tables = [
    ["lexical_entries", ENTRY_COLUMNS, data.entries],
    ["lexical_source_blocks", BLOCK_COLUMNS, data.sourceBlocks],
    ["lexical_occurrences", OCCURRENCE_COLUMNS, data.occurrences]
  ] as const;
  for (const [table, columns, rows] of tables) {
    sql += `CREATE TEMP TABLE stage_${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT DROP;\n`;
    sql += copySql(`stage_${table}`, columns, rows);
  }
  sql += "LOCK TABLE public.lexical_entries, public.lexical_source_blocks, public.lexical_occurrences IN SHARE ROW EXCLUSIVE MODE;\n";
  // Fail closed if the destination contains any non-identical row; exact partial runs can safely resume.
  for (const [table, columns] of tables) {
    const cols = columns.join(",");
    sql += `DO $$ BEGIN IF EXISTS (SELECT ${cols} FROM public.${table} EXCEPT SELECT ${cols} FROM stage_${table}) THEN RAISE EXCEPTION 'Non-identical destination ${table}; import refused'; END IF; END $$;\n`;
    sql += `INSERT INTO public.${table} (${cols}) SELECT ${cols} FROM stage_${table} ON CONFLICT DO NOTHING;\n`;
    sql += `DO $$ BEGIN IF EXISTS (SELECT ${cols} FROM stage_${table} EXCEPT SELECT ${cols} FROM public.${table}) THEN RAISE EXCEPTION 'Import mismatch ${table}'; END IF; END $$;\n`;
  }
  sql += `DO $$ BEGIN IF (SELECT count(*) FROM public.lexical_entries) <> 13043 OR (SELECT count(*) FROM public.lexical_occurrences) <> 149411 OR (SELECT count(*) FROM public.lexical_source_blocks) <> ${data.sourceBlocks.length} THEN RAISE EXCEPTION 'Final corpus count mismatch'; END IF; END $$;\nCOMMIT;\n`;
  return sql;
}

// Keep only the finalizer's frozen successor gate, not the historical coordinator,
// checkpoint or enrichment execution layer.
function assertConsolidationCompletion(summary: Row, directory: string) {
  const equal = (actual: unknown, expected: unknown, label: string) => {
    if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} mismatch.`);
  };
  equal(directory, SUCCESSOR, "Formal successor directory (partial artifacts are forbidden)");
  equal(summary.version, "lexical-resolution-aware-consolidation-v1", "Formal consolidation version");
  equal([summary.complete, summary.consolidation_complete, summary.import_ready, summary.enrichment_started],
    [true, true, false, false], "Consolidation completion flags");
  equal([summary.input?.layer1, summary.input?.corrected_layer2, summary.input?.combined_audited],
    [140153, 9259, 149412], "Consolidation audited input");
  const a = summary.mapping_audit ?? {};
  equal([a.source_input_audited_occurrences, a.explicit_invalid_exclusions, a.publishable_occurrences, a.mapped_occurrences],
    [149412, 1, 149411, 149411], "Publishable mapping / explicit exclusions");
  for (const field of ["unexpected_unmapped", "duplicate_mapping", "unknown_mapping", "removed_mwe_reappearing",
    "duplicate_entry_key", "unsafe_collision", "unresolved_review_groups"]) equal(a[field], 0, `Consolidation ${field}`);
  equal([summary.consolidated?.entries, summary.consolidated?.occurrences], [13043, 149411], "Final entries / occurrences");
  const r = summary.review ?? {};
  equal([r.resolution_groups, r.affected_occurrences, r.mapped_review_occurrences, r.unresolved, r.explicitly_excluded_invalid_occurrences],
    [59, 5224, 5223, 0, 1], "Complete review dispositions");
  equal(r.actions, {MERGE_VARIANTS: 50, SPLIT_ENTRIES: 8, EXCLUDE_INVALID_OCCURRENCE: 1, MANUAL_REVIEW: 0}, "Final resolution actions");
  for (const field of ["missing_review_groups", "duplicate_review_groups", "unknown_review_groups",
    "missing_occurrence_assignment", "duplicate_occurrence_assignment", "unknown_occurrence_assignment"]) equal(r[field], 0, `Review ${field}`);
}

export async function finalizeProduction(root = process.cwd()) {
  const read = (f: string) => readFile(path.join(root, f), "utf8");
  const workflow = JSON.parse(await read("tmp/lexical-v1/generation-manifest.json"));
  assert(workflow.phase === "agent_consolidation_complete" && workflow.consolidation?.enrichment_started === false,
    "Unexpected workflow phase or enrichment already started");
  const manifest = JSON.parse(await read(`${SUCCESSOR}/artifact-manifest.json`));
  for (const a of manifest.artifacts) assert(sha(await read(`${SUCCESSOR}/${a.artifact_path}`)) === a.sha256, `Successor artifact changed: ${a.artifact_path}`);
  const summary = JSON.parse(await read(`${SUCCESSOR}/summary.json`));
  assertConsolidationCompletion(summary, SUCCESSOR);
  assert(!(await read(`${SUCCESSOR}/conflicts-review.jsonl`)).trim(), "Unresolved consolidation review");
  const deps = JSON.parse(await read(`${SUCCESSOR}/dependency-manifest.json`)).dependencies as Row[];
  async function frozen(file: string) {
    const bindings = deps.filter(d => d.artifact_path === file);
    assert(bindings.length, `Missing frozen binding: ${file}`);
    const bytes = await read(file);
    assert(bindings.every(d => d.sha256 === sha(bytes)), `Frozen dependency changed: ${file}`);
    return parse(bytes);
  }
  const data = buildProductionDataset({ entries: parse(await read(`${SUCCESSOR}/lexical-entries.jsonl`)),
    mappings: parse(await read(`${SUCCESSOR}/occurrence-entry-mapping.jsonl`)),
    exclusions: parse(await read(`${SUCCESSOR}/invalid-occurrence-exclusions.jsonl`)),
    blocks: await frozen("tmp/lexical-v1/canonical-blocks.jsonl"),
    removed: await frozen("tmp/lexical-v1/mwe-corrected/removed-occurrences.jsonl") });
  await mkdir(path.join(root, PRODUCTION_DIRECTORY), { recursive: true });
  const files = new Map<string, string>([
    ["lexical-entries.jsonl", data.entries.map(v => JSON.stringify(v)).join("\n") + "\n"],
    ["lexical-occurrences.jsonl", data.occurrences.map(v => JSON.stringify(v)).join("\n") + "\n"],
    ["lexical-source-blocks.jsonl", data.sourceBlocks.map(v => JSON.stringify(v)).join("\n") + "\n"],
    ["entry-identity-mapping.jsonl", parse(await read(`${SUCCESSOR}/lexical-entries.jsonl`)).map(e => JSON.stringify({ entry_key: e.entry_key, entry_id: productionId("entry", e.entry_key) })).join("\n") + "\n"],
    ["structural-qa.json", JSON.stringify(data.qa, null, 2) + "\n"],
    ["import.sql", productionImportSql(data, await read("supabase/lexical_v1_production_identity.sql"))]
  ]);
  for (const [file, bytes] of Array.from(files)) {
    const target = path.join(root, PRODUCTION_DIRECTORY, file);
    await writeFile(`${target}.tmp`, bytes); await rename(`${target}.tmp`, target);
  }
  const publication = { complete: true, import_ready: true, enrichment_required: false, qa: data.qa,
    successor_manifest_sha256: sha(await read(`${SUCCESSOR}/artifact-manifest.json`)),
    artifacts: Array.from(files, ([artifact_path, bytes]) => ({ artifact_path, sha256: sha(bytes) })) };
  const publicationPath = path.join(root, PRODUCTION_DIRECTORY, "manifest.json");
  await writeFile(`${publicationPath}.tmp`, JSON.stringify(publication, null, 2) + "\n");
  await rename(`${publicationPath}.tmp`, publicationPath);
  // Preserve the existing phase; V1 publication does not introduce a pipeline phase.
  const workflowPath = path.join(root, "tmp/lexical-v1/generation-manifest.json");
  await writeFile(`${workflowPath}.tmp`, JSON.stringify({ ...workflow,
    complete: true, import_ready: true, remaining_work: [], stop_reason: null,
    production: { directory: PRODUCTION_DIRECTORY, ...publication } }, null, 2) + "\n");
  await rename(`${workflowPath}.tmp`, workflowPath);
  return publication;
}
