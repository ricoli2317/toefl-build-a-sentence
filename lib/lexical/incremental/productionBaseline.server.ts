import { baselineLine, legacyBaselineLinesMd5 } from "./artifacts.ts";
import { baselineRowsSha256 } from "./baselineHash.ts";
import { canonicalSourceTextHash } from "../hash.ts";
import type { CanonicalLexicalSourceType } from "../types.ts";

type ReadOnlySupabase = { from: (table: string) => any };

const PAGE_SIZE = 1_000;

export type ProductionBlockRow = {
  block_id: string;
  source_type: CanonicalLexicalSourceType;
  source_item_id: string;
  content_block_id: string;
  block_kind: string;
  source_text_hash: string;
  generation_status: string;
  generation_version: string | null;
  last_error: string | null;
};

export type ProductionEntryRow = {
  entry_id: string;
  canonical_expression: string;
  normalized_expression: string;
  expression_type: string;
  lemma: string | null;
  common_senses: unknown;
  derived_words: unknown;
  useful_patterns: unknown;
  review_status: string;
  generation_version: string;
  review_notes: string | null;
  identity_variant: string;
};

export type ProductionOccurrenceRow = {
  occurrence_id: string;
  entry_id: string;
  source_type: CanonicalLexicalSourceType;
  source_item_id: string;
  content_block_id: string;
  sentence_id: string | null;
  source_anchor_id: string | null;
  surface_text: string;
  normalized_surface: string;
  start_offset: number;
  end_offset: number;
  context_pos: string | null;
  context_meaning_zh: string;
  context_definition_en: string | null;
  review_status: string;
  generation_version: string;
  review_notes: string | null;
};

async function selectAllRows(
  db: ReadOnlySupabase,
  table: string,
  columns: string,
  cursorColumn: string,
  onProgress?: (count: number) => void
) {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (;;) {
    // Read through the existing primary-key index instead of repeatedly sorting and
    // discarding deep OFFSET prefixes. Hash ordering is applied locally afterwards.
    let query = db.from(table).select(columns).order(cursorColumn, { ascending: true }).limit(PAGE_SIZE);
    if (cursor !== null) query = query.gt(cursorColumn, cursor);
    const { data, error } = await query;
    if (error) throw new Error(`Failed to read ${table}: ${error.message}`);
    const page = (data ?? []) as Record<string, unknown>[];
    for (const row of page) {
      const id = row[cursorColumn];
      if (typeof id !== "string" || !id || (cursor !== null && id <= cursor)) {
        throw new Error(`Invalid or non-advancing primary-key page from ${table}.`);
      }
      cursor = id;
    }
    rows.push(...page);
    onProgress?.(rows.length);
    if (page.length < PAGE_SIZE) return rows;
  }
}

export const PRODUCTION_BLOCK_COLUMNS = [
  "block_id", "source_type", "source_item_id", "content_block_id", "block_kind",
  "source_text_hash", "generation_status", "generation_version", "last_error"
].join(",");

export const PRODUCTION_ENTRY_COLUMNS = [
  "entry_id", "canonical_expression", "normalized_expression", "expression_type", "lemma",
  "common_senses", "derived_words", "useful_patterns", "review_status", "generation_version",
  "review_notes", "identity_variant"
].join(",");

export const PRODUCTION_OCCURRENCE_HASH_COLUMNS = [
  "occurrence_id", "entry_id", "source_type", "source_item_id", "content_block_id",
  "sentence_id", "source_anchor_id", "surface_text", "normalized_surface", "start_offset", "end_offset",
  "context_pos", "context_meaning_zh", "context_definition_en", "review_status", "generation_version", "review_notes"
].join(",");

export async function readProductionBlocks(db: ReadOnlySupabase, onProgress?: (count: number) => void) {
  return sortBlocks(await selectAllRows(db, "lexical_source_blocks", PRODUCTION_BLOCK_COLUMNS,
    "block_id", onProgress) as unknown as ProductionBlockRow[]);
}

export async function readProductionEntries(db: ReadOnlySupabase, onProgress?: (count: number) => void) {
  return sortEntries(await selectAllRows(db, "lexical_entries", PRODUCTION_ENTRY_COLUMNS,
    "entry_id", onProgress) as unknown as ProductionEntryRow[]);
}

export async function readProductionOccurrencesForHash(db: ReadOnlySupabase, onProgress?: (count: number) => void) {
  return sortOccurrences(await selectAllRows(db, "lexical_occurrences", PRODUCTION_OCCURRENCE_HASH_COLUMNS,
    "occurrence_id", onProgress) as unknown as ProductionOccurrenceRow[]);
}

/** Capture every persisted field, including JSON semantics, context_text, and audit timestamps. */
export async function readFullProductionSnapshot(db: ReadOnlySupabase) {
  const blocks = await selectAllRows(db, "lexical_source_blocks", "*", "block_id");
  const entries = await selectAllRows(db, "lexical_entries", "*", "entry_id");
  const occurrences = await selectAllRows(db, "lexical_occurrences", "*", "occurrence_id");
  return { blocks: sortBlocks(blocks as unknown as ProductionBlockRow[]), entries: sortEntries(entries as unknown as ProductionEntryRow[]), occurrences: sortOccurrences(occurrences as unknown as ProductionOccurrenceRow[]) };
}

const compareText = (left: string, right: string) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export const blockIdentityKey = (row: Pick<ProductionBlockRow, "source_type" | "source_item_id" | "content_block_id">) =>
  `${row.source_type}:${row.source_item_id}:${row.content_block_id}`;

export const occurrenceIdentity = (row: Pick<ProductionOccurrenceRow, "source_type" | "source_item_id" | "content_block_id" | "start_offset" | "end_offset">) =>
  `${row.source_type}:${row.source_item_id}:${row.content_block_id}:${row.start_offset}:${row.end_offset}`;

export function blockBaselineLine(row: ProductionBlockRow & { block_id?: string }) {
  return baselineLine([
    row.block_id, row.source_type, row.source_item_id, row.content_block_id, row.block_kind,
    row.source_text_hash, row.generation_status, row.generation_version ?? "", row.last_error ?? ""
  ]);
}

export function entryBaselineLine(row: ProductionEntryRow) {
  return baselineLine([
    row.entry_id, row.canonical_expression, row.normalized_expression, row.expression_type,
    row.lemma ?? "", row.review_status, row.identity_variant, row.generation_version, row.review_notes ?? ""
  ]);
}

export function occurrenceBaselineLine(row: ProductionOccurrenceRow) {
  return baselineLine([
    row.occurrence_id, row.entry_id, row.source_type, row.source_item_id, row.content_block_id,
    row.sentence_id ?? "", row.source_anchor_id ?? "", row.surface_text, row.normalized_surface,
    row.start_offset, row.end_offset, row.context_pos ?? "", row.context_meaning_zh,
    row.context_definition_en ?? "", row.review_status, row.generation_version, row.review_notes ?? ""
  ]);
}

export function sortBlocks(rows: ProductionBlockRow[]) {
  return [...rows].sort((left, right) =>
    compareText(left.source_type, right.source_type)
    || compareText(left.source_item_id, right.source_item_id)
    || compareText(left.content_block_id, right.content_block_id));
}

export function sortEntries(rows: ProductionEntryRow[]) {
  return [...rows].sort((left, right) =>
    compareText(left.normalized_expression, right.normalized_expression)
    || compareText(left.expression_type, right.expression_type)
    || compareText(left.identity_variant, right.identity_variant));
}

export function sortOccurrences(rows: ProductionOccurrenceRow[]) {
  return [...rows].sort((left, right) =>
    compareText(left.source_type, right.source_type)
    || compareText(left.source_item_id, right.source_item_id)
    || compareText(left.content_block_id, right.content_block_id)
    || left.start_offset - right.start_offset
    || left.end_offset - right.end_offset
    || compareText(left.occurrence_id, right.occurrence_id));
}

export function productionBaselineHashes(input: {
  blocks: ProductionBlockRow[];
  entries: ProductionEntryRow[];
  occurrences: ProductionOccurrenceRow[];
}) {
  return {
    blocks_sha256: baselineRowsSha256(sortBlocks(input.blocks)),
    entries_sha256: baselineRowsSha256(sortEntries(input.entries)),
    occurrences_sha256: baselineRowsSha256(sortOccurrences(input.occurrences))
  };
}

/** Read-only compatibility guard for the very first plan, whose legacy labels were incorrect. */
export function legacyProductionBaselineHashes(input: { blocks: ProductionBlockRow[]; entries: ProductionEntryRow[]; occurrences: ProductionOccurrenceRow[] }) {
  return {
    blocks_md5: legacyBaselineLinesMd5(sortBlocks(input.blocks).map(blockBaselineLine)),
    entries_md5: legacyBaselineLinesMd5(sortEntries(input.entries).map(entryBaselineLine)),
    occurrences_md5: legacyBaselineLinesMd5(sortOccurrences(input.occurrences).map(occurrenceBaselineLine))
  };
}

export function productionHealth(input: {
  blocks: ProductionBlockRow[];
  entries: ProductionEntryRow[];
  occurrences: ProductionOccurrenceRow[];
}) {
  const blockKeys = new Set(input.blocks.map(blockIdentityKey));
  const entryIds = new Set(input.entries.map((entry) => entry.entry_id));
  const spanKeys = new Set<string>();
  let duplicateSpans = 0;
  let orphanOccurrences = 0;
  let missingBlocks = 0;
  for (const occurrence of input.occurrences) {
    const span = occurrenceIdentity(occurrence);
    if (spanKeys.has(span)) duplicateSpans += 1;
    spanKeys.add(span);
    if (!entryIds.has(occurrence.entry_id)) orphanOccurrences += 1;
    if (!blockKeys.has(blockIdentityKey(occurrence))) missingBlocks += 1;
  }
  const identityKeys = new Set<string>();
  let duplicateEntryIdentity = 0;
  for (const entry of input.entries) {
    const identity = `${entry.normalized_expression}\u0000${entry.expression_type}\u0000${entry.identity_variant}`;
    if (identityKeys.has(identity)) duplicateEntryIdentity += 1;
    identityKeys.add(identity);
  }
  const hashMismatchBlocks = input.blocks.filter((block) => {
    const expected = block.source_text_hash;
    return !/^[0-9a-f]{64}$/.test(expected);
  }).length;
  const nonGeneratedBlocks = input.blocks.filter((block) => block.generation_status !== "generated").length;
  return {
    entries: input.entries.length,
    blocks: input.blocks.length,
    occurrences: input.occurrences.length,
    orphan_occurrences: orphanOccurrences,
    missing_blocks: missingBlocks,
    duplicate_spans: duplicateSpans,
    duplicate_entry_identity: duplicateEntryIdentity,
    invalid_block_hash_format: hashMismatchBlocks,
    non_generated_blocks: nonGeneratedBlocks
  };
}

/**
 * Plan-time guard for production rows the delta pipeline is allowed to trust.
 * Content blocks must already carry a canonical hash over the stored generation text.
 */
export function assertProductionBaselineIntegrity(input: {
  blocks: ProductionBlockRow[];
  entries: ProductionEntryRow[];
  occurrences: ProductionOccurrenceRow[];
}) {
  const health = productionHealth(input);
  for (const field of ["orphan_occurrences", "missing_blocks", "duplicate_spans", "duplicate_entry_identity",
    "invalid_block_hash_format", "non_generated_blocks"] as const) {
    if (health[field] !== 0) throw new Error(`Production lexical baseline is not healthy: ${field}=${health[field]}.`);
  }
  return health;
}

export function blockTextHashMatches(text: string, hash: string) {
  return canonicalSourceTextHash(text) === hash;
}
