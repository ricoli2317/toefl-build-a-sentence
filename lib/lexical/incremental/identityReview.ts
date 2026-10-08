import type { LexicalBlockWork, LexicalOccurrenceArtifact } from "../generationTypes.ts";
import { lexicalEntryKey } from "../generationTypes.ts";
import { normalizeLexicalExpression } from "../normalize.ts";
import { lexicalSemanticIssues } from "../semantic.ts";
import { validateAnnotationBatch } from "../annotation.ts";
import { tokenAnnotationsFromOccurrences } from "../agentProtocol.ts";
import { lexicalSemanticProvenanceMatches } from "../provenance.ts";
import { baselineRowsSha256 } from "./baselineHash.ts";
import { occurrenceIdentityOf } from "./consolidation.ts";
import type { ProductionEntryRow } from "./productionBaseline.server.ts";
import type { IncrementalAgentProvenance } from "./envelope.ts";

export type EntryIdentityResolution = {
  source_occurrence_id: string;
  source_occurrence_sha256: string;
  entry_id: string;
  identity_variant: string;
  concise_reason: string;
  provenance: IncrementalAgentProvenance;
};

/** Explicit, revision-bound identity review overlay; frozen checkpoints and production stay intact. */
export function applyReviewedEntryIdentities(input: {
  works: LexicalBlockWork[];
  occurrences: LexicalOccurrenceArtifact[];
  productionEntries: ProductionEntryRow[];
  resolutions: EntryIdentityResolution[];
  provenance: IncrementalAgentProvenance;
}) {
  const originals = new Map(input.occurrences.map(row => [occurrenceIdentityOf(row), row]));
  const entries = new Map(input.productionEntries.map(row => [row.entry_id, row]));
  const overlays = new Map<string, LexicalOccurrenceArtifact>();
  const identityVariantAssignments = new Map<string, string>();
  const allowed = ["source_occurrence_id", "source_occurrence_sha256", "entry_id", "identity_variant", "concise_reason", "provenance"].sort().join(",");
  for (const resolution of input.resolutions) {
    const original = originals.get(resolution.source_occurrence_id);
    const entry = entries.get(resolution.entry_id);
    if (Object.keys(resolution).sort().join(",") !== allowed || !original || !entry || overlays.has(resolution.source_occurrence_id)
      || baselineRowsSha256([original]) !== resolution.source_occurrence_sha256 || !resolution.concise_reason?.trim()
      || entry.identity_variant !== resolution.identity_variant || entry.normalized_expression !== original.normalized_expression
      || entry.expression_type !== original.expression_type || !lexicalSemanticProvenanceMatches(resolution.provenance, input.provenance)) {
      throw new Error("Invalid, stale, duplicate, or identity-changing reviewed entry resolution.");
    }
    // This overlay is deliberately case/convention-only, not a loophole for re-annotating senses.
    if (entry.canonical_expression.toLocaleLowerCase("en-US") !== original.canonical_expression.toLocaleLowerCase("en-US")
      || (entry.lemma ?? "").toLocaleLowerCase("en-US") !== original.lemma.toLocaleLowerCase("en-US")) {
      throw new Error("Identity review cannot silently change canonical/lemma semantic identity.");
    }
    const corrected = { ...original, canonical_expression: entry.canonical_expression, lemma: entry.lemma ?? "" };
    const normalized = normalizeLexicalExpression(corrected.canonical_expression, corrected.expression_type);
    if (normalized !== entry.normalized_expression || lexicalSemanticIssues(corrected).length) throw new Error("Reviewed entry convention violates frozen semantic validators.");
    overlays.set(resolution.source_occurrence_id, { ...corrected, normalized_expression: normalized, entry_key: lexicalEntryKey(normalized, corrected.expression_type) });
    identityVariantAssignments.set(resolution.source_occurrence_id, entry.identity_variant);
  }
  const occurrences = input.occurrences.map(row => overlays.get(occurrenceIdentityOf(row)) ?? row);
  const layer1 = occurrences.filter(row => row.layer === 1);
  const changedBlocks = new Set(Array.from(overlays.values()).filter(row => row.layer === 1).map(row => `${row.source_type}:${row.source_item_id}:${row.content_block_id}`));
  const workKeys = new Set(input.works.map(work => `${work.block.sourceType}:${work.block.sourceItemId}:${work.block.contentBlockId}`));
  if (Array.from(changedBlocks).some(key => !workKeys.has(key))) throw new Error("Reviewed identity overlay has no canonical work for validator replay.");
  for (const work of input.works.filter(work => changedBlocks.has(`${work.block.sourceType}:${work.block.sourceItemId}:${work.block.contentBlockId}`))) {
    const key = `${work.block.sourceType}:${work.block.sourceItemId}:${work.block.contentBlockId}`;
    const expected = layer1.filter(row => `${row.source_type}:${row.source_item_id}:${row.content_block_id}` === key);
    const blocks = tokenAnnotationsFromOccurrences([work], expected).map(block => ({ ...block, expressions: [] }));
    const validated = validateAnnotationBatch([work], { blocks });
    // Final consolidation orders occurrence IDs lexically, whereas materialization uses
    // token order (e.g. offset 10 sorts before 2). Compare the same exact row set.
    const ordered = (rows: LexicalOccurrenceArtifact[]) => [...rows].sort((left, right) => left.start_offset - right.start_offset || left.end_offset - right.end_offset);
    if (baselineRowsSha256(ordered(validated)) !== baselineRowsSha256(ordered(expected))) throw new Error("Reviewed identity overlay changed fields outside its approved convention.");
  }
  return { occurrences, identityVariantAssignments, reviewed: overlays.size };
}
