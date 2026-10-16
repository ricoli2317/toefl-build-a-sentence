import { validateAnnotationBatch } from "../annotation.ts";
import { tokenAnnotationsFromOccurrences } from "../agentProtocol.ts";
import type { LexicalBlockWork, LexicalOccurrenceArtifact } from "../generationTypes.ts";
import type { CanonicalLexicalBlock } from "../types.ts";
import { lexicalSemanticProvenanceMatches } from "../provenance.ts";
import { canonicalSourceTextHash } from "../hash.ts";
import { baselineRowsSha256 } from "./baselineHash.ts";
import { occurrenceIdentityOf } from "./consolidation.ts";
import type { IncrementalAgentProvenance } from "./envelope.ts";

export const LAYER1_REVIEW_FILE = "layer1-semantic-reviews.jsonl";
type Corrections = Partial<Pick<LexicalOccurrenceArtifact, "context_pos" | "context_meaning_zh" | "context_definition_en">>;
export type Layer1SemanticReview = {
  source_occurrence_id: string;
  source_occurrence_sha256: string;
  verdict: "confirm" | "correct";
  concise_reason: string;
  evidence: Array<{ block_key: string; source_text_sha256: string; quote: string }>;
  provenance: IncrementalAgentProvenance;
  corrections?: Corrections;
};
const blockKey = (block: CanonicalLexicalBlock) => `${block.sourceType}:${block.sourceItemId}:${block.contentBlockId}`;
const rowBlockKey = (row: LexicalOccurrenceArtifact) => `${row.source_type}:${row.source_item_id}:${row.content_block_id}`;

/** Explicit Layer-1 semantic adjudication. Never rewrites a checkpoint or an identity.
 * All flagged occurrences must have one revision-bound decision, and all changed blocks
 * replay the original complete-token validator against immutable canonical works.
 */
export function applyLayer1SemanticReviews(input: {
  works: LexicalBlockWork[];
  canonicalBlocks: CanonicalLexicalBlock[];
  occurrences: LexicalOccurrenceArtifact[];
  reviews: Layer1SemanticReview[];
  provenance: IncrementalAgentProvenance;
}) {
  const originals = new Map(input.occurrences.map(row => [occurrenceIdentityOf(row), row]));
  if (originals.size !== input.occurrences.length) throw new Error("Duplicate occurrence before Layer-1 semantic review.");
  const blocks = new Map(input.canonicalBlocks.map(block => [blockKey(block), block]));
  const works = new Map(input.works.map(work => [blockKey(work.block), work]));
  const replacements = new Map<string, LexicalOccurrenceArtifact>();
  let confirmed = 0, corrected = 0;
  for (const review of input.reviews) {
    const allowed = ["source_occurrence_id", "source_occurrence_sha256", "verdict", "concise_reason", "evidence", "provenance",
      ...(review.verdict === "correct" ? ["corrections"] : [])].sort().join(",");
    const row = originals.get(review.source_occurrence_id);
    if (Object.keys(review).sort().join(",") !== allowed || !row || row.layer !== 1 || row.review_status !== "needs_review"
      || replacements.has(review.source_occurrence_id) || baselineRowsSha256([row]) !== review.source_occurrence_sha256
      || !["confirm", "correct"].includes(review.verdict) || typeof review.concise_reason !== "string" || !review.concise_reason.trim()
      || !lexicalSemanticProvenanceMatches(review.provenance, input.provenance)) {
      throw new Error("Invalid, stale, duplicate or out-of-scope Layer-1 semantic review.");
    }
    const work = works.get(rowBlockKey(row));
    if (!work || work.block.text !== row.context_text || blocks.get(rowBlockKey(row))?.text !== row.context_text) {
      throw new Error("Layer-1 semantic review has no matching canonical work.");
    }
    if (!Array.isArray(review.evidence) || !review.evidence.length) throw new Error("Layer-1 semantic review needs canonical evidence.");
    for (const evidence of review.evidence) {
      const block = blocks.get(evidence.block_key);
      if (Object.keys(evidence).sort().join(",") !== "block_key,quote,source_text_sha256"
        || !block || block.sourceType !== row.source_type || block.sourceItemId !== row.source_item_id
        || canonicalSourceTextHash(block.text) !== evidence.source_text_sha256
        || typeof evidence.quote !== "string" || !evidence.quote.trim() || !block.text.includes(evidence.quote)) {
        throw new Error("Layer-1 review evidence must quote the same canonical source item at its exact hash.");
      }
    }
    const corrections = review.corrections ?? {};
    if (review.verdict === "correct" && (!review.corrections || !Object.keys(corrections).length
      || Object.keys(corrections).some(key => !["context_pos", "context_meaning_zh", "context_definition_en"].includes(key))
      || Object.values(corrections).some(value => typeof value !== "string" || !value.trim())
      || Object.entries(corrections).every(([key, value]) => row[key as keyof Corrections] === value))) {
      throw new Error("Layer-1 corrections must change only explicitly whitelisted contextual semantic fields.");
    }
    const replacement: LexicalOccurrenceArtifact = { ...row, ...corrections, review_status: "generated",
      review_notes: `Layer-1 reviewed (${review.verdict}): ${review.concise_reason.trim()} Original flag: ${row.review_notes ?? "none"}` };
    replacements.set(review.source_occurrence_id, replacement);
    if (review.verdict === "confirm") confirmed++; else corrected++;
  }
  const occurrences = input.occurrences.map(row => replacements.get(occurrenceIdentityOf(row)) ?? row);
  if (occurrences.some(row => row.review_status === "needs_review")) throw new Error("Unresolved semantic review occurrences; publication is not import-ready.");
  const changedBlocks = new Set(Array.from(replacements.values()).map(rowBlockKey));
  const layer1 = occurrences.filter(row => row.layer === 1);
  for (const key of Array.from(changedBlocks)) {
    const work = works.get(key)!;
    const expected = layer1.filter(row => rowBlockKey(row) === key);
    const annotations = tokenAnnotationsFromOccurrences([work], expected).map(block => ({ ...block, expressions: [] }));
    const actual = validateAnnotationBatch([work], { blocks: annotations });
    const ordered = (rows: LexicalOccurrenceArtifact[]) => [...rows].sort((a, b) => a.start_offset - b.start_offset || a.end_offset - b.end_offset);
    if (baselineRowsSha256(ordered(actual)) !== baselineRowsSha256(ordered(expected))) {
      throw new Error("Layer-1 semantic review failed complete canonical-work validator replay.");
    }
  }
  return { occurrences, summary: { reviewed: replacements.size, confirmed, corrected, unresolved: 0 } };
}
