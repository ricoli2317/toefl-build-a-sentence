import type { ConsolidatedEntrySeed } from "./consolidate.ts";
import type { LexicalOccurrenceArtifact } from "./generationTypes.ts";
import { qaEntries, qaOccurrenceSemantics, type LexicalBlockQa } from "./qa.ts";

export type LexicalCompletionAssessment = {
  complete: boolean;
  phase: "complete" | "blocked_model_capacity" | "blocked_qa";
  remainingWork: string[];
  blockingIssues: {
    annotation_model_failure_occurrences: number;
    mwe_model_failure_blocks: number;
    enrichment_model_failure_entries: number;
    structural_qa_failure_blocks: number;
    semantic_qa_issue_occurrences: number;
    semantic_qa_issue_entries: number;
    unsafe_recovery_blocks: number;
  };
};

export function assessLexicalCompletion(
  occurrences: LexicalOccurrenceArtifact[],
  entries: ConsolidatedEntrySeed[],
  blockQa: LexicalBlockQa[]
): LexicalCompletionAssessment {
  const annotationFailures = occurrences.filter((occurrence) =>
    occurrence.review_notes?.includes("model_schema_failure")
  ).length;
  const mweFailureBlocks = new Set(occurrences.filter((occurrence) =>
    occurrence.review_notes?.includes("mwe_model_failure")
  ).map((occurrence) =>
    `${occurrence.source_type}:${occurrence.source_item_id}:${occurrence.content_block_id}`
  )).size;
  const enrichmentFailures = entries.filter((entry) =>
    entry.review_notes?.includes("enrichment_model_failure")
  ).length;
  const structuralFailures = blockQa.filter((qa) => qa.generationStatus === "failed").length;
  const semanticOccurrenceIssues = qaOccurrenceSemantics(occurrences).length;
  const semanticEntryIssues = qaEntries(entries).length;
  const remainingWork: string[] = [];

  if (annotationFailures) remainingWork.push(`retry_semantic_annotation:${annotationFailures}_occurrences`);
  if (mweFailureBlocks) remainingWork.push(`retry_mwe_detection:${mweFailureBlocks}_blocks`);
  if (enrichmentFailures) remainingWork.push(`retry_entry_enrichment:${enrichmentFailures}_entries`);
  if (structuralFailures) remainingWork.push(`resolve_structural_qa:${structuralFailures}_blocks`);
  if (semanticOccurrenceIssues) remainingWork.push(`resolve_semantic_qa:${semanticOccurrenceIssues}_occurrences`);
  if (semanticEntryIssues) remainingWork.push(`resolve_entry_qa:${semanticEntryIssues}_entries`);
  if (remainingWork.length) remainingWork.push("rerun_qa_and_artifacts");

  const modelBlocked = annotationFailures > 0 || mweFailureBlocks > 0 || enrichmentFailures > 0;
  const qaBlocked = structuralFailures > 0 || semanticOccurrenceIssues > 0 || semanticEntryIssues > 0;
  return {
    complete: remainingWork.length === 0,
    phase: modelBlocked ? "blocked_model_capacity" : qaBlocked ? "blocked_qa" : "complete",
    remainingWork,
    blockingIssues: {
      annotation_model_failure_occurrences: annotationFailures,
      mwe_model_failure_blocks: mweFailureBlocks,
      enrichment_model_failure_entries: enrichmentFailures,
      structural_qa_failure_blocks: structuralFailures,
      semantic_qa_issue_occurrences: semanticOccurrenceIssues,
      semantic_qa_issue_entries: semanticEntryIssues,
      unsafe_recovery_blocks: 0
    }
  };
}
