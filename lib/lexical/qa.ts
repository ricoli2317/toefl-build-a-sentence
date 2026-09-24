import type {
  ConsolidatedEntrySeed
} from "./consolidate.ts";
import type {
  LexicalBlockWork,
  LexicalOccurrenceArtifact
} from "./generationTypes.ts";
import { lexicalEntryContentIssues, lexicalSemanticIssues } from "./semantic.ts";

export type LexicalBlockQa = {
  sourceType: string;
  sourceItemId: string;
  contentBlockId: string;
  blockKind: string;
  eligibleTokens: number;
  excludedTokens: number;
  coveredLayer1: number;
  missingTokens: number;
  coveragePercent: number;
  invalidSpans: number;
  duplicateExactSpans: number;
  generationStatus: "generated" | "needs_review" | "failed";
  reasons: string[];
};

export function qaLexicalBlock(
  work: LexicalBlockWork,
  occurrences: LexicalOccurrenceArtifact[],
  failedReason?: string | null
): LexicalBlockQa {
  const eligible = work.tokens.filter((token) => !token.excluded);
  const excluded = work.tokens.length - eligible.length;
  const blockOccurrences = occurrences.filter((occurrence) =>
    occurrence.source_type === work.block.sourceType &&
    occurrence.source_item_id === work.block.sourceItemId &&
    occurrence.content_block_id === work.block.contentBlockId
  );
  const layer1Spans = new Set(
    blockOccurrences.filter((occurrence) => occurrence.layer === 1)
      .map((occurrence) => `${occurrence.start_offset}:${occurrence.end_offset}`)
  );
  const missing = eligible.filter((token) => !layer1Spans.has(`${token.startOffset}:${token.endOffset}`));
  let invalidSpans = 0;
  const exactSpans = new Set<string>();
  let duplicateExactSpans = 0;
  for (const occurrence of blockOccurrences) {
    if (
      occurrence.start_offset < 0 ||
      occurrence.end_offset <= occurrence.start_offset ||
      occurrence.end_offset > work.block.text.length ||
      work.block.text.slice(occurrence.start_offset, occurrence.end_offset) !== occurrence.surface_text
    ) invalidSpans += 1;
    const span = `${occurrence.start_offset}:${occurrence.end_offset}`;
    if (exactSpans.has(span)) duplicateExactSpans += 1;
    exactSpans.add(span);
  }
  const reasons = [
    failedReason ?? null,
    missing.length ? `missing_token_annotations:${missing.length}` : null,
    invalidSpans ? `invalid_spans:${invalidSpans}` : null,
    duplicateExactSpans ? `duplicate_exact_spans:${duplicateExactSpans}` : null,
    blockOccurrences.some((occurrence) => occurrence.review_status === "needs_review") ? "occurrence_needs_review" : null
  ].filter((value): value is string => value !== null);
  const failed = Boolean(failedReason) || missing.length > 0 || invalidSpans > 0 || duplicateExactSpans > 0;
  return {
    sourceType: work.block.sourceType,
    sourceItemId: work.block.sourceItemId,
    contentBlockId: work.block.contentBlockId,
    blockKind: work.block.blockKind,
    eligibleTokens: eligible.length,
    excludedTokens: excluded,
    coveredLayer1: eligible.length - missing.length,
    missingTokens: missing.length,
    coveragePercent: eligible.length === 0 ? 100 : ((eligible.length - missing.length) / eligible.length) * 100,
    invalidSpans,
    duplicateExactSpans,
    generationStatus: failed ? "failed" : reasons.length ? "needs_review" : "generated",
    reasons
  };
}

export function qaEntries(entries: ConsolidatedEntrySeed[]) {
  const seen = new Set<string>();
  const issues: Array<{ entryKey: string; reasons: string[] }> = [];
  for (const entry of entries) {
    const reasons: string[] = [];
    if (seen.has(entry.entry_key)) reasons.push("duplicate_entry_key");
    seen.add(entry.entry_key);
    if (!entry.canonical_expression.trim()) reasons.push("empty_canonical_expression");
    if (!entry.lemma.trim()) reasons.push("empty_lemma");
    reasons.push(...lexicalEntryContentIssues(entry));
    if ((entry.sample_occurrences ?? []).some((occurrence) =>
      occurrence.review_notes?.includes("model_schema_failure") ||
      lexicalSemanticIssues(occurrence).length > 0
    )) reasons.push("fallback_or_invalid_sample_occurrence");
    if (reasons.length) issues.push({ entryKey: entry.entry_key, reasons });
  }
  return issues;
}

export function qaOccurrenceSemantics(occurrences: LexicalOccurrenceArtifact[]) {
  return occurrences.flatMap((occurrence) => {
    const reasons = lexicalSemanticIssues(occurrence);
    return reasons.length ? [{ occurrence, reasons }] : [];
  });
}
