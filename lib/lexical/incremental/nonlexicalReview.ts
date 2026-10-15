import type { CanonicalLexicalBlock } from "../types.ts";
import { hyphenatedCompounds, type HyphenatedCompound } from "../hyphenated.ts";
import { canonicalSourceTextHash } from "../hash.ts";
import { lexicalSemanticProvenanceMatches } from "../provenance.ts";
import { fileExists, readJsonl, readRequiredJson, sha256File } from "./artifacts.ts";
import { incrementalFile } from "./paths.ts";
import { incrementalAgentProvenance, type IncrementalAgentProvenance } from "./envelope.ts";

export const NONLEXICAL_REVIEW_FILE = "nonlexical-scope-reviews.json";
export type IncrementalNonlexicalReview = HyphenatedCompound & {
  decision: "not_lexical_compound";
  reason: string;
  source_text_hash: string;
};
export type IncrementalNonlexicalReviews = {
  version: "lexical-incremental-nonlexical-review-v1";
  delta_plan_sha256: string;
  canonical_blocks_sha256: string;
  independent_review_sha256: string;
  provenance: IncrementalAgentProvenance;
  reviews: IncrementalNonlexicalReview[];
};
type Span = Pick<HyphenatedCompound, "source_type" | "source_item_id" | "content_block_id" | "start_offset" | "end_offset" | "surface_text">;
const keyOf = (s: Span) => JSON.stringify([s.source_type, s.source_item_id, s.content_block_id, s.start_offset, s.end_offset, s.surface_text]);
const blockKey = (s: Pick<Span, "source_type" | "source_item_id" | "content_block_id">) => `${s.source_type}:${s.source_item_id}:${s.content_block_id}`;

/** Explicit semantic adjudication only: no global regex exceptions or source edits. */
export function validateIncrementalNonlexicalReviews(blocks: CanonicalLexicalBlock[], reviews: IncrementalNonlexicalReview[]) {
  const candidates = new Map(blocks.flatMap(hyphenatedCompounds).map(span => [keyOf(span), span]));
  const seen = new Set<string>();
  if (!Array.isArray(reviews)) throw new Error("Nonlexical reviews must be an array.");
  for (const review of reviews) {
    const key = keyOf(review);
    const original = candidates.get(key);
    const allowed = ["source_type", "source_item_id", "content_block_id", "start_offset", "end_offset", "surface_text", "context_text", "decision", "reason", "source_text_hash"];
    if (seen.has(key) || !original || Object.keys(review).sort().join() !== allowed.sort().join()
      || review.decision !== "not_lexical_compound" || typeof review.reason !== "string" || !review.reason.trim()
      || review.context_text !== original.context_text || review.source_text_hash !== canonicalSourceTextHash(original.context_text)) {
      throw new Error("Invalid, duplicate, or stale incremental nonlexical span review.");
    }
    seen.add(key);
  }
  return seen;
}

/** Validate the complete review inventory, then select only the current batch's decisions. */
export async function loadIncrementalNonlexicalReviews(root: string) {
  const file = incrementalFile(root, NONLEXICAL_REVIEW_FILE);
  if (!await fileExists(file)) return { sha256: null, reviews: [] as IncrementalNonlexicalReview[] };
  const artifact = await readRequiredJson<IncrementalNonlexicalReviews>(file);
  const fields = ["version", "delta_plan_sha256", "canonical_blocks_sha256", "independent_review_sha256", "provenance", "reviews"];
  if (Object.keys(artifact).sort().join() !== fields.sort().join()
    || artifact.version !== "lexical-incremental-nonlexical-review-v1"
    || artifact.delta_plan_sha256 !== await sha256File(incrementalFile(root, "delta-plan.json"))
    || artifact.canonical_blocks_sha256 !== await sha256File(incrementalFile(root, "canonical-blocks.jsonl"))
    || artifact.independent_review_sha256 !== await sha256File(incrementalFile(root, "independent-nonlexical-review.json"))
    || !lexicalSemanticProvenanceMatches(artifact.provenance, incrementalAgentProvenance())
    || Object.keys(artifact.provenance).length !== 4 || !artifact.reviews?.length) {
    throw new Error("Incremental nonlexical review binding/provenance mismatch.");
  }
  const rows = await readJsonl<{ source_type: CanonicalLexicalBlock["sourceType"]; source_item_id: string; content_block_id: string; block_kind: string; text: string }>(incrementalFile(root, "canonical-blocks.jsonl"));
  const plan = await readRequiredJson<{ new_blocks: Span[]; changed_blocks: Span[] }>(incrementalFile(root, "delta-plan.json"));
  const deltaKeys = new Set([...plan.new_blocks, ...plan.changed_blocks].map(blockKey));
  const blocks = rows.filter(row => deltaKeys.has(blockKey(row))).map(row => ({ sourceType: row.source_type, sourceItemId: row.source_item_id, contentBlockId: row.content_block_id, blockKind: row.block_kind, text: row.text }));
  validateIncrementalNonlexicalReviews(blocks, artifact.reviews);
  const independent = await readRequiredJson<{ verdict: string; source_text_hash: string; source_type: string; source_item_id: string; content_block_id: string; start_offset: number; end_offset: number; surface_text: string; rationale: string; provenance: IncrementalAgentProvenance }>(incrementalFile(root, "independent-nonlexical-review.json"));
  // A single independent adjudication cannot authorize a larger exclusion inventory.
  if (artifact.reviews.length !== 1 || independent.verdict !== "not_lexical_compound"
    || keyOf(independent) !== keyOf(artifact.reviews[0]) || independent.source_text_hash !== artifact.reviews[0].source_text_hash
    || !independent.rationale?.trim() || !lexicalSemanticProvenanceMatches(independent.provenance, artifact.provenance)) {
    throw new Error("Independent nonlexical adjudication does not cover the reviewed span.");
  }
  return { sha256: await sha256File(file), reviews: artifact.reviews };
}

export function scopedNonlexicalReviews(blocks: CanonicalLexicalBlock[], reviews: IncrementalNonlexicalReview[]) {
  const keys = new Set(blocks.map(b => `${b.sourceType}:${b.sourceItemId}:${b.contentBlockId}`));
  return reviews.filter(review => keys.has(blockKey(review)));
}

export function incrementalHyphenatedCoverage(blocks: CanonicalLexicalBlock[], occurrences: Span[], reviews: IncrementalNonlexicalReview[] = []) {
  const excluded = validateIncrementalNonlexicalReviews(blocks, reviews);
  const present = new Set(occurrences.map(keyOf));
  if (reviews.some(review => present.has(keyOf(review)))) throw new Error("Adjudicated nonlexical span must not be published as a lexical occurrence.");
  const raw = blocks.flatMap(hyphenatedCompounds);
  const required = raw.filter(span => !excluded.has(keyOf(span)));
  const missing = required.filter(span => !present.has(keyOf(span)));
  return { raw_total: raw.length, reviewed_nonlexical: excluded.size, total: required.length, covered: required.length - missing.length, missing };
}

export function assertIncrementalHyphenatedCoverage(blocks: CanonicalLexicalBlock[], occurrences: Span[], reviews: IncrementalNonlexicalReview[] = []) {
  const result = incrementalHyphenatedCoverage(blocks, occurrences, reviews);
  if (result.missing.length) throw new Error(`Missing complete hyphenated occurrences (${result.missing.length}): ${JSON.stringify(result.missing)}`);
  return result;
}
