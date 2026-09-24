import { createHash } from "node:crypto";
import { LEXICAL_GENERATION_VERSION, type LexicalBlockWork } from "./generationTypes.ts";
import type { ConsolidatedEntrySeed } from "./consolidate.ts";

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function lexicalBlockCacheIdentity(work: LexicalBlockWork) {
  return {
    generation_version: LEXICAL_GENERATION_VERSION,
    source_type: work.block.sourceType,
    source_item_id: work.block.sourceItemId,
    content_block_id: work.block.contentBlockId,
    source_text_hash: work.sourceTextHash
  };
}

export function lexicalAnnotationBatchCacheKey(works: LexicalBlockWork[]) {
  return sha256(JSON.stringify(works.map(lexicalBlockCacheIdentity)));
}

export function lexicalEntryEnrichmentCacheKey(entry: ConsolidatedEntrySeed) {
  return sha256(JSON.stringify({
    generation_version: LEXICAL_GENERATION_VERSION,
    normalized_expression: entry.normalized_expression,
    expression_type: entry.expression_type
  }));
}

export function lexicalEntryEnrichmentInputSignature(entry: ConsolidatedEntrySeed) {
  return sha256(JSON.stringify({
    canonical_expression: entry.canonical_expression,
    normalized_expression: entry.normalized_expression,
    expression_type: entry.expression_type,
    lemma: entry.lemma,
    review_status: entry.review_status,
    review_notes: entry.review_notes,
    samples: (entry.sample_occurrences ?? []).map((occurrence) => ({
      source_type: occurrence.source_type,
      source_item_id: occurrence.source_item_id,
      content_block_id: occurrence.content_block_id,
      surface_text: occurrence.surface_text,
      start_offset: occurrence.start_offset,
      end_offset: occurrence.end_offset,
      context_pos: occurrence.context_pos,
      context_meaning_zh: occurrence.context_meaning_zh,
      context_definition_en: occurrence.context_definition_en,
      context_text: occurrence.context_text,
      review_status: occurrence.review_status,
      review_notes: occurrence.review_notes
    }))
  }));
}

export function annotationCacheMatches(
  cache: { generation_version?: unknown; blocks?: unknown },
  works: LexicalBlockWork[]
) {
  return cache.generation_version === LEXICAL_GENERATION_VERSION &&
    JSON.stringify(cache.blocks) === JSON.stringify(works.map(lexicalBlockCacheIdentity));
}

export function enrichmentCacheMatches(
  cache: {
    generation_version?: unknown;
    normalized_expression?: unknown;
    expression_type?: unknown;
    input_signature?: unknown;
  },
  entry: ConsolidatedEntrySeed
) {
  return cache.generation_version === LEXICAL_GENERATION_VERSION &&
    cache.normalized_expression === entry.normalized_expression &&
    cache.expression_type === entry.expression_type &&
    cache.input_signature === lexicalEntryEnrichmentInputSignature(entry);
}
