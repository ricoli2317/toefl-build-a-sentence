import { canonicalSourceTextHash } from "../hash.ts";
import type { LexicalBlockWork, LexicalOccurrenceArtifact } from "../generationTypes.ts";
import { blockIdentityKey, type ProductionEntryRow, type ProductionBlockRow, type ProductionOccurrenceRow } from "./productionBaseline.server.ts";
import type { DeltaPlan } from "./deltaPlan.ts";
import { occurrenceIdentityOf, type DeltaConsolidation } from "./consolidation.ts";
import type { DeltaConflict } from "./consolidation.ts";

export type DeltaQaReport = {
  production_baseline_health: Record<string, number>;
  delta_coverage: {
    delta_blocks: number;
    eligible_tokens: number;
    layer1_occurrences: number;
    missing_eligible_token: number;
    unexpected_layer1_occurrence: number;
    invalid_utf16: number;
    slice_mismatch: number;
    duplicate_exact_span: number;
    missing_entry_mapping: number;
    missing_delta_block: number;
  };
  layer2: {
    occurrences: number;
    qa_status: string;
    qa_removed: number;
    qa_corrected: number;
    qa_pass: number;
  };
  consolidation: {
    reused_entries: number;
    new_entries: number;
    unresolved_conflicts: number;
    identity_conflicts: number;
    orphan_delta_occurrences: number;
    conflicts: DeltaConflict[];
  };
  write_safety: {
    unchanged_blocks: number;
    unchanged_blocks_in_artifacts: number;
    unchanged_occurrence_spans_in_delta: number;
    planned_unchanged_writes: number;
  };
  import_ready: boolean;
};

function utf16Boundary(text: string, offset: number) {
  return !(offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]));
}

export function runDeltaQa(input: {
  deltaPlan: DeltaPlan;
  works: LexicalBlockWork[];
  occurrences: LexicalOccurrenceArtifact[];
  consolidation: DeltaConsolidation;
  artifactBlockKeys: string[];
  productionHealth: Record<string, number>;
  baselineDrift: string | null;
  layer2Qa: { removed: number; corrected: number; pass: number; status: string };
  productionOccurrences: ProductionOccurrenceRow[];
  productionEntries: ProductionEntryRow[];
  productionBlocks: ProductionBlockRow[];
}): DeltaQaReport {
  if (input.baselineDrift) throw new Error(`Production baseline drifted after delta generation: ${input.baselineDrift}`);
  for (const field of ["orphan_occurrences", "missing_blocks", "duplicate_spans", "duplicate_entry_identity",
    "invalid_block_hash_format", "non_generated_blocks"] as const) {
    if (input.productionHealth[field] !== 0) {
      throw new Error(`Production baseline health failed: ${field}=${input.productionHealth[field]}.`);
    }
  }

  const deltaBlocks = new Map<string, { text: string; kind: string; hash: string }>();
  for (const block of input.deltaPlan.new_blocks.concat(input.deltaPlan.changed_blocks)) {
    deltaBlocks.set(`${block.source_type}:${block.source_item_id}:${block.content_block_id}`, {
      text: "", kind: block.block_kind, hash: block.new_hash ?? ""
    });
  }
  for (const work of input.works) {
    const key = `${work.block.sourceType}:${work.block.sourceItemId}:${work.block.contentBlockId}`;
    const entry = deltaBlocks.get(key);
    if (!entry) throw new Error(`Works contain a block outside the delta plan: ${key}.`);
    entry.text = work.block.text;
    if (canonicalSourceTextHash(work.block.text) !== entry.hash) throw new Error(`Delta works hash mismatch for ${key}.`);
  }
  if (deltaBlocks.size !== input.works.length) throw new Error("Delta works do not cover every new/changed block.");

  const artifactKeys = new Set(input.artifactBlockKeys);
  if (artifactKeys.size !== input.artifactBlockKeys.length || Array.from(artifactKeys).some(key => !deltaBlocks.has(key))) throw new Error("Artifact block set is not exactly the new/changed delta set.");
  let missingDeltaBlock = 0;
  Array.from(deltaBlocks.keys()).forEach((key) => {
    if (!artifactKeys.has(key)) missingDeltaBlock += 1;
  });

  let eligibleTokens = 0;
  const layer1ByToken = new Set<string>();
  for (const work of input.works) {
    const eligible = work.tokens.filter((token) => !token.excluded);
    eligibleTokens += eligible.length;
    for (const token of eligible) {
      layer1ByToken.add(`${token.sourceType}:${token.sourceItemId}:${token.contentBlockId}:${token.startOffset}:${token.endOffset}`);
    }
  }
  const occurrenceSpans = new Set<string>();
  const layer1Spans = new Set<string>();
  let unexpectedLayer1 = 0;
  let invalidUtf16 = 0;
  let sliceMismatch = 0;
  let duplicateExactSpan = 0;
  let missingEntryMapping = 0;
  let orphanDeltaOccurrences = 0;
  const occurrenceBlockKeys = new Set<string>();
  for (const occurrence of input.occurrences) {
    const key = `${occurrence.source_type}:${occurrence.source_item_id}:${occurrence.content_block_id}`;
    occurrenceBlockKeys.add(key);
    const block = deltaBlocks.get(key);
    if (!block) {
      missingDeltaBlock += 1;
      continue;
    }
    if (!Number.isInteger(occurrence.start_offset) || !Number.isInteger(occurrence.end_offset)
      || occurrence.start_offset < 0 || occurrence.end_offset <= occurrence.start_offset || occurrence.end_offset > block.text.length
      || !utf16Boundary(block.text, occurrence.start_offset) || !utf16Boundary(block.text, occurrence.end_offset)) {
      invalidUtf16 += 1;
    }
    if (block.text.slice(occurrence.start_offset, occurrence.end_offset) !== occurrence.surface_text) sliceMismatch += 1;
    const span = occurrenceIdentityOf(occurrence);
    if (occurrence.context_text !== block.text) sliceMismatch += 1;
    if (occurrence.layer === 1) {
      layer1Spans.add(span);
      if (!layer1ByToken.has(span)) unexpectedLayer1 += 1;
    } else if (occurrence.layer !== 2) unexpectedLayer1 += 1;
    if (occurrenceSpans.has(span)) duplicateExactSpan += 1;
    occurrenceSpans.add(span);
    if (!input.consolidation.assignments.has(span)) {
      missingEntryMapping += 1;
      orphanDeltaOccurrences += 1;
    }
  }
  let missingEligibleToken = 0;
  Array.from(layer1ByToken).forEach((tokenKey) => {
    if (!layer1Spans.has(tokenKey)) missingEligibleToken += 1;
  });
  const layer1Count = input.occurrences.filter((occurrence) => occurrence.layer === 1).length;

  const unchangedKeys = new Set(input.deltaPlan.unchanged_blocks.map((block) =>
    `${block.source_type}:${block.source_item_id}:${block.content_block_id}`));
  const unchangedInArtifacts = input.artifactBlockKeys.filter((key) => unchangedKeys.has(key)).length;
  const productionSpansForUnchanged = new Set(input.productionOccurrences
    .filter((occurrence) => unchangedKeys.has(blockIdentityKey(occurrence)))
    .map((occurrence) => occurrenceIdentityOf(occurrence)));
  const unchangedSpansInDelta = input.occurrences.filter((occurrence) =>
    productionSpansForUnchanged.has(occurrenceIdentityOf(occurrence))).length;

  const importedBlockKeys = new Set(input.artifactBlockKeys);
  for (const key of input.deltaPlan.changed_blocks.map((block) =>
    `${block.source_type}:${block.source_item_id}:${block.content_block_id}`)) importedBlockKeys.add(key);
  const plannedUnchangedWrites = input.deltaPlan.unchanged_blocks.filter((block) =>
    importedBlockKeys.has(`${block.source_type}:${block.source_item_id}:${block.content_block_id}`)).length;

  const unresolved = input.consolidation.conflicts.length;
  const report: DeltaQaReport = {
    production_baseline_health: input.productionHealth,
    delta_coverage: {
      delta_blocks: deltaBlocks.size,
      eligible_tokens: eligibleTokens,
      layer1_occurrences: layer1Count,
      missing_eligible_token: missingEligibleToken,
      unexpected_layer1_occurrence: unexpectedLayer1,
      invalid_utf16: invalidUtf16,
      slice_mismatch: sliceMismatch,
      duplicate_exact_span: duplicateExactSpan,
      missing_entry_mapping: missingEntryMapping,
      missing_delta_block: missingDeltaBlock
    },
    layer2: {
      occurrences: input.occurrences.filter((occurrence) => occurrence.layer === 2).length,
      qa_status: input.layer2Qa.status,
      qa_removed: input.layer2Qa.removed,
      qa_corrected: input.layer2Qa.corrected,
      qa_pass: input.layer2Qa.pass
    },
    consolidation: {
      reused_entries: input.consolidation.reusedEntries.length,
      new_entries: input.consolidation.newEntries.length,
      unresolved_conflicts: unresolved,
      identity_conflicts: input.consolidation.conflicts.filter((conflict) =>
        conflict.reasons.includes("homograph_identity_requires_review")).length,
      orphan_delta_occurrences: orphanDeltaOccurrences,
      conflicts: input.consolidation.conflicts
    },
    write_safety: {
      unchanged_blocks: input.deltaPlan.unchanged_blocks.length,
      unchanged_blocks_in_artifacts: unchangedInArtifacts,
      unchanged_occurrence_spans_in_delta: unchangedSpansInDelta,
      planned_unchanged_writes: plannedUnchangedWrites
    },
    import_ready: false
  };
  const hardFailures = [
    report.delta_coverage.missing_eligible_token,
    report.delta_coverage.unexpected_layer1_occurrence,
    report.delta_coverage.invalid_utf16,
    report.delta_coverage.slice_mismatch,
    report.delta_coverage.duplicate_exact_span,
    report.delta_coverage.missing_entry_mapping,
    report.delta_coverage.missing_delta_block,
    report.consolidation.orphan_delta_occurrences,
    report.write_safety.unchanged_blocks_in_artifacts,
    report.write_safety.unchanged_occurrence_spans_in_delta,
    report.write_safety.planned_unchanged_writes
  ];
  if (hardFailures.some((value) => value !== 0)) {
    throw new Error(`Delta QA structural failure: ${JSON.stringify(report)}`);
  }
  report.import_ready = unresolved === 0;
  return report;
}
