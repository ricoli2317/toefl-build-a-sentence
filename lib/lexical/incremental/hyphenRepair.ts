import { baselineRowsSha256, baselineRowsHashSql, BASELINE_HASH_SQL } from "./baselineHash.ts";
import { fullSnapshotHashes, type FullProductionSnapshot } from "./importBaseline.ts";
import { ENTRY_COLUMNS, OCCURRENCE_COLUMNS } from "../production.ts";
import { hyphenatedCoverage, approvedHyphenatedCoverage, type HyphenatedCompound } from "../hyphenated.ts";
import { canonicalSourceTextHash } from "../hash.ts";
import { lexicalSemanticIssues } from "../semantic.ts";
import type { CanonicalLexicalBlock } from "../types.ts";
import type { deltaEntryRow, deltaOccurrenceRow } from "./consolidation.ts";
import type { LexicalExpressionType } from "../generationTypes.ts";
import { lexicalSemanticProvenanceMatches } from "../provenance.ts";

type Row = Record<string, any>;
export type HyphenRepairDataset = {
  version: "lexical-hyphen-repair-v1";
  blocks: CanonicalLexicalBlock[];
  entries: ReturnType<typeof deltaEntryRow>[];
  occurrences: ReturnType<typeof deltaOccurrenceRow>[];
  /** Optional reviewed whitelist for a history audit, including numeric hyphen spans. */
  approved_spans?: HyphenatedCompound[];
  excluded_source_items?: string[];
  /** Exact source punctuation junctions adjudicated during independent semantic QA. */
  nonlexical_reviews?: ReviewedNonlexicalHyphenSpan[];
  baseline: { hashes: ReturnType<typeof fullSnapshotHashes>; counts: { entries: number; blocks: number; occurrences: number } };
};

export type ReviewedNonlexicalHyphenSpan = HyphenatedCompound & {
  decision: "not_lexical_compound";
  reason: string;
  source_text_hash: string;
  review_input_sha256: string;
  review_output_sha256: string;
};

const repairSpanKey = (o: HyphenatedCompound) => JSON.stringify([o.source_type, o.source_item_id, o.content_block_id, o.start_offset, o.end_offset, o.surface_text]);

function reviewedNonlexicalKeys(blocks: CanonicalLexicalBlock[], approved: HyphenatedCompound[] | undefined, reviews?: ReviewedNonlexicalHyphenSpan[]) {
  if (!reviews?.length) return new Set<string>();
  if (!approved) throw new Error("Nonlexical scope reviews require an audit-bound approved inventory.");
  const approvedKeys = new Set(approved.map(repairSpanKey));
  const seen = new Set<string>();
  for (const review of reviews) {
    const key = repairSpanKey(review);
    const block = blocks.find(b => b.sourceType === review.source_type && b.sourceItemId === review.source_item_id && b.contentBlockId === review.content_block_id);
    if (seen.has(key) || !approvedKeys.has(key) || !block || review.decision !== "not_lexical_compound" || !review.reason?.trim()
      || review.context_text !== block.text || block.text.slice(review.start_offset, review.end_offset) !== review.surface_text
      || review.source_text_hash !== canonicalSourceTextHash(block.text)
      || !/^[a-f0-9]{64}$/.test(review.review_input_sha256) || !/^[a-f0-9]{64}$/.test(review.review_output_sha256)) throw new Error("Invalid, duplicate, or stale nonlexical scope review.");
    seen.add(key);
  }
  return seen;
}

export function missingHyphenRepairSpans(blocks: CanonicalLexicalBlock[], occurrences: FullProductionSnapshot["occurrences"], approved?: HyphenatedCompound[], reviews?: ReviewedNonlexicalHyphenSpan[]) {
  const ordinary = hyphenatedCoverage(blocks, occurrences).missing;
  if (!approved) {
    if (reviews?.length) throw new Error("Nonlexical scope reviews require an audit-bound approved inventory.");
    return ordinary;
  }
  const coverage = approvedHyphenatedCoverage(blocks, occurrences, approved);
  const required = new Set(coverage.missing.map(repairSpanKey));
  if (ordinary.some(o => !required.has(repairSpanKey(o))) || coverage.covered) throw new Error("Approved repair whitelist is incomplete or includes already-covered spans.");
  const excluded = reviewedNonlexicalKeys(blocks, approved, reviews);
  return coverage.missing.filter(o => !excluded.has(repairSpanKey(o)));
}

export function hyphenRepairCoverage(data: Pick<HyphenRepairDataset, "blocks" | "approved_spans" | "nonlexical_reviews">, occurrences: FullProductionSnapshot["occurrences"]) {
  const excluded = reviewedNonlexicalKeys(data.blocks, data.approved_spans, data.nonlexical_reviews);
  const ordinary = hyphenatedCoverage(data.blocks, occurrences);
  const approved = data.approved_spans ? approvedHyphenatedCoverage(data.blocks, occurrences, data.approved_spans) : ordinary;
  return { ordinary_total: ordinary.total, approved_total: approved.total, reviewed_nonlexical: excluded.size,
    raw_ordinary_missing: ordinary.missing.length, ordinary_missing: ordinary.missing.filter(o => !excluded.has(repairSpanKey(o))),
    approved_missing: approved.missing.filter(o => !excluded.has(repairSpanKey(o))) };
}

export function validateHyphenRepairSemanticQa(qa: Row, annotations: Row) {
  const expected = annotations.blocks.flatMap((b: Row) => b.expressions.map((e: Row) => ({ ...e, block_key: b.block_key })));
  const key = (r: Row) => JSON.stringify([r.block_key, r.start_offset, r.end_offset, r.surface_text]);
  if (qa.version !== "compound-semantic-qa-v1" || !lexicalSemanticProvenanceMatches(qa.provenance, annotations.provenance)
    || !Array.isArray(qa.reviews) || qa.reviews.length !== expected.length || new Set(qa.reviews.map(key)).size !== expected.length) throw new Error("Repair semantic QA coverage/provenance mismatch.");
  for (const review of qa.reviews) {
    const expression = expected.find((e: Row) => key(e) === key(review));
    if (!expression || review.status !== "PASS" || review.action !== "retain" || typeof review.reason !== "string" || !review.reason.trim()
      || !review.corrections || Object.keys(review.corrections).length
      || ["canonical_expression", "lemma", "context_pos", "expression_type"].some(f => review[f] !== expression[f])) throw new Error("Repair semantic QA is incomplete, stale, or has unresolved issues.");
  }
  return { reviewed: expected.length, pass: expected.length, unresolved: 0 };
}

/** Validate an append-only repair against its immutable baseline; never replace existing tokens. */
export function validateHyphenRepair(data: HyphenRepairDataset, baseline: FullProductionSnapshot) {
  if (data.version !== "lexical-hyphen-repair-v1" || !data.occurrences.length) throw new Error("Invalid or empty hyphen repair.");
  if (JSON.stringify(data.baseline.hashes) !== JSON.stringify(fullSnapshotHashes(baseline))
    || JSON.stringify(data.baseline.counts) !== JSON.stringify({ entries: baseline.entries.length, blocks: baseline.blocks.length, occurrences: baseline.occurrences.length })) throw new Error("Repair baseline binding mismatch.");
  const key = (o: Row) => JSON.stringify([o.source_type, o.source_item_id, o.content_block_id, o.start_offset, o.end_offset]);
  const excluded = new Set(data.excluded_source_items ?? []);
  if (data.blocks.some(b => excluded.has(b.sourceItemId)) || data.occurrences.some(o => excluded.has(o.source_item_id))
    || data.approved_spans?.some(o => excluded.has(o.source_item_id))) throw new Error("Repair includes an explicitly excluded source item.");
  const missing = missingHyphenRepairSpans(data.blocks, baseline.occurrences, data.approved_spans, data.nonlexical_reviews);
  if (missing.length !== data.occurrences.length || new Set(data.occurrences.map(key)).size !== missing.length) throw new Error("Repair is not exactly the missing compound set.");
  const entries = new Map([...baseline.entries, ...data.entries].map(e => [e.entry_id, e]));
  for (const b of data.blocks) {
    const stored = baseline.blocks.find(row => row.source_type === b.sourceType && row.source_item_id === b.sourceItemId && row.content_block_id === b.contentBlockId);
    if (!stored || stored.source_text_hash !== canonicalSourceTextHash(b.text)) throw new Error("Repair canonical block differs from production.");
  }
  const baselineIds = new Set(baseline.occurrences.map(o => o.occurrence_id));
  for (const row of data.occurrences) {
    const m = missing.find(m => key(m) === key(row));
    const entry = entries.get(row.entry_id);
    if (!m || m.surface_text !== row.surface_text || m.context_text !== row.context_text
      || baselineIds.has(row.occurrence_id) || !entry || lexicalSemanticIssues({ ...row, expression_type: entry.expression_type as LexicalExpressionType,
        canonical_expression: entry.canonical_expression, lemma: entry.lemma ?? undefined }).length) throw new Error("Invalid hyphen repair occurrence/semantics.");
  }
  const usedEntries = new Set(data.occurrences.map(o => o.entry_id));
  const baselineEntryIds = new Set(baseline.entries.map(e => e.entry_id));
  const identity = (e: Row) => JSON.stringify([e.normalized_expression, e.expression_type, e.identity_variant]);
  const identities = new Set(baseline.entries.map(identity));
  const newIds = new Set<string>();
  for (const row of data.entries) {
    if (baselineEntryIds.has(row.entry_id) || newIds.has(row.entry_id) || identities.has(identity(row)) || !usedEntries.has(row.entry_id)) throw new Error("Repair entry collision or unused entry.");
    newIds.add(row.entry_id); identities.add(identity(row));
  }
  const coverage = hyphenRepairCoverage(data, [...baseline.occurrences, ...data.occurrences]);
  if (coverage.ordinary_missing.length || coverage.approved_missing.length) throw new Error("Repair did not cover every approved lexical compound.");
}

const projection = (row: Row, columns: readonly string[]) => Object.fromEntries(columns.map(c => [c, row[c]]));
export function preflightHyphenRepair(data: HyphenRepairDataset, baseline: FullProductionSnapshot, live: FullProductionSnapshot) {
  validateHyphenRepair(data, baseline);
  const newEntries = new Set(data.entries.map(e => e.entry_id));
  const newOccurrences = new Set(data.occurrences.map(o => o.occurrence_id));
  const unrelated = { entries: live.entries.filter(e => !newEntries.has(e.entry_id)), blocks: live.blocks,
    occurrences: live.occurrences.filter(o => !newOccurrences.has(o.occurrence_id)) };
  if (JSON.stringify(fullSnapshotHashes(unrelated)) !== JSON.stringify(data.baseline.hashes)) throw new Error("Repair production baseline drift.");
  const present = (rows: Row[], expected: Row[], columns: readonly string[], id: string) => expected.map(e => {
    const row = rows.find(row => row[id] === e[id]);
    if (row && baselineRowsSha256([projection(row, columns)]) !== baselineRowsSha256([projection(e, columns)])) throw new Error("Repair staged row semantic drift.");
    return Boolean(row);
  });
  const states = [...present(live.entries, data.entries, ENTRY_COLUMNS, "entry_id"),
    ...present(live.occurrences, data.occurrences, OCCURRENCE_COLUMNS, "occurrence_id")];
  if (states.some(Boolean) && !states.every(Boolean)) throw new Error("Repair mixed fresh/applied state.");
  return { state: states.every(Boolean) ? "applied" : "fresh", compatible: true, production_writes: 0 };
}

const copy = (table: string, columns: readonly string[], rows: Row[]) => {
  const cell = (v: unknown) => v == null ? "" : `"${(typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/"/g, '""')}"`;
  return `COPY ${table} (${columns.join(",")}) FROM STDIN WITH (FORMAT csv);\n${rows.length ? rows.map(row => columns.map(c => cell(row[c])).join(",")).join("\n") + "\n" : ""}\\.\n`;
};

/** Single insert-only transaction. All pre-existing rows, including timestamps, are hash-protected.
 * Blocks are never modified. Reruns are exact semantic no-ops, not ON CONFLICT reconciliation.
 */
export function buildHyphenRepairSql(data: HyphenRepairDataset) {
  for (const hash of Object.values(data.baseline.hashes)) if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid repair baseline hash.");
  for (const count of Object.values(data.baseline.counts)) if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid repair baseline count.");
  const order = { entries: 'e.normalized_expression COLLATE "C", e.expression_type COLLATE "C", e.identity_variant COLLATE "C"',
    blocks: 'b.source_type COLLATE "C", b.source_item_id COLLATE "C", b.content_block_id COLLATE "C"',
    occurrences: 'o.source_type COLLATE "C", o.source_item_id COLLATE "C", o.content_block_id COLLATE "C", o.start_offset, o.end_offset, o.occurrence_id' };
  const protectedHashes = () => `
    IF (${baselineRowsHashSql("public.lexical_entries", "e", order.entries, "NOT EXISTS (SELECT 1 FROM repair_entries s WHERE s.entry_id=e.entry_id)")}) <> '${data.baseline.hashes.entries_sha256}'
      OR (${baselineRowsHashSql("public.lexical_source_blocks", "b", order.blocks)}) <> '${data.baseline.hashes.blocks_sha256}'
      OR (${baselineRowsHashSql("public.lexical_occurrences", "o", order.occurrences, "NOT EXISTS (SELECT 1 FROM repair_occurrences s WHERE s.occurrence_id=o.occurrence_id)")}) <> '${data.baseline.hashes.occurrences_sha256}'
    THEN RAISE EXCEPTION 'Repair baseline drift / pre-existing row mutation'; END IF;`;
  const semanticMismatch = (table: string, staged: string, columns: readonly string[], id: string) => {
    const comparisons = columns.map(c => `s.${c} IS DISTINCT FROM p.${c}`).join(" OR ");
    return `EXISTS (SELECT 1 FROM ${staged} s JOIN public.${table} p USING (${id}) WHERE ${comparisons})`;
  };
  const stagedPresent = (table: string, staged: string, id: string) => `(SELECT count(*) FROM ${staged} s JOIN public.${table} p USING (${id}))`;
  return `\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '10min';
SET LOCAL timezone = 'UTC';
SELECT pg_advisory_xact_lock(7631043);
LOCK TABLE public.lexical_entries, public.lexical_source_blocks, public.lexical_occurrences IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE required record;
BEGIN
  FOR required IN SELECT * FROM (VALUES
    ('lexical_entries','entry_id'), ('lexical_entries','normalized_expression,expression_type,identity_variant'),
    ('lexical_source_blocks','block_id'), ('lexical_source_blocks','source_type,source_item_id,content_block_id'),
    ('lexical_occurrences','occurrence_id'), ('lexical_occurrences','source_type,source_item_id,content_block_id,start_offset,end_offset')
  ) AS keys(table_name,column_names) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace
      WHERE ns.nspname='public' AND t.relname=required.table_name AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL
        AND (SELECT string_agg(a.attname, ',' ORDER BY k.ordinality)
          FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.attnum
          WHERE k.ordinality <= i.indnkeyatts)=required.column_names)
    THEN RAISE EXCEPTION 'Repair schema lacks required unique identity: % (%)', required.table_name, required.column_names; END IF;
  END LOOP;
END $$;
CREATE TEMP TABLE repair_entries (LIKE public.lexical_entries INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT DROP;
CREATE TEMP TABLE repair_occurrences (LIKE public.lexical_occurrences INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT DROP;
${copy("repair_entries", ENTRY_COLUMNS, data.entries)}${copy("repair_occurrences", OCCURRENCE_COLUMNS, data.occurrences)}${BASELINE_HASH_SQL}
DO $$
DECLARE present_entries bigint; present_occurrences bigint;
BEGIN
${protectedHashes()}
  IF ${semanticMismatch("lexical_entries", "repair_entries", ENTRY_COLUMNS, "entry_id")}
    OR ${semanticMismatch("lexical_occurrences", "repair_occurrences", OCCURRENCE_COLUMNS, "occurrence_id")}
  THEN RAISE EXCEPTION 'Repair staged semantic drift'; END IF;
  present_entries := ${stagedPresent("lexical_entries", "repair_entries", "entry_id")};
  present_occurrences := ${stagedPresent("lexical_occurrences", "repair_occurrences", "occurrence_id")};
  IF present_entries=0 AND present_occurrences=0 THEN
    INSERT INTO public.lexical_entries (${ENTRY_COLUMNS.join(",")}) SELECT ${ENTRY_COLUMNS.join(",")} FROM repair_entries;
    INSERT INTO public.lexical_occurrences (${OCCURRENCE_COLUMNS.join(",")}) SELECT ${OCCURRENCE_COLUMNS.join(",")} FROM repair_occurrences;
  ELSIF present_entries<>${data.entries.length} OR present_occurrences<>${data.occurrences.length} THEN
    RAISE EXCEPTION 'Repair mixed fresh/applied state';
  END IF;
${protectedHashes()}
  IF ${semanticMismatch("lexical_entries", "repair_entries", ENTRY_COLUMNS, "entry_id")}
    OR ${semanticMismatch("lexical_occurrences", "repair_occurrences", OCCURRENCE_COLUMNS, "occurrence_id")}
    OR ${stagedPresent("lexical_entries", "repair_entries", "entry_id")}<>${data.entries.length}
    OR ${stagedPresent("lexical_occurrences", "repair_occurrences", "occurrence_id")}<>${data.occurrences.length}
    OR (SELECT count(*) FROM public.lexical_entries)<>${data.baseline.counts.entries + data.entries.length}
    OR (SELECT count(*) FROM public.lexical_source_blocks)<>${data.baseline.counts.blocks}
    OR (SELECT count(*) FROM public.lexical_occurrences)<>${data.baseline.counts.occurrences + data.occurrences.length}
    OR EXISTS (SELECT 1 FROM repair_occurrences s WHERE NOT EXISTS (SELECT 1 FROM public.lexical_source_blocks b WHERE b.source_type=s.source_type AND b.source_item_id=s.source_item_id AND b.content_block_id=s.content_block_id))
  THEN RAISE EXCEPTION 'Repair post-verification failed'; END IF;
END $$;
COMMIT;
`;
}
