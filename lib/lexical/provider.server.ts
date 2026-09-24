import {
  getWritingReviewProviderConfig,
  requestWritingReviewStructuredOutput,
  type WritingReviewProviderConfig
} from "../writingReviewProvider.ts";
import {
  LEXICAL_ANNOTATION_JSON_SCHEMA,
  lexicalBlockKey,
  validateAnnotationBatch
} from "./annotation.ts";
import {
  LEXICAL_ENRICHMENT_JSON_SCHEMA,
  applyEntryEnrichment,
  type ConsolidatedEntrySeed
} from "./consolidate.ts";
import type { LexicalBlockWork, LexicalOccurrenceArtifact } from "./generationTypes.ts";

type StructuredRequest = typeof requestWritingReviewStructuredOutput;

export function getLexicalProviderConfig(
  env: Partial<NodeJS.ProcessEnv> = process.env
): WritingReviewProviderConfig {
  const provider = env.LEXICAL_PROVIDER?.trim() || "moonshot";
  const model = env.LEXICAL_MODEL?.trim();
  return getWritingReviewProviderConfig({
    ...env,
    WRITING_REVIEW_PROVIDER: provider,
    ...(provider === "moonshot" && model ? { MOONSHOT_WRITING_MODEL: model } : {}),
    ...(provider === "openrouter" && model ? { OPENROUTER_WRITING_MODEL: model } : {}),
    ...(provider === "deepseek_flash" && model ? { DEEPSEEK_WRITING_MODEL: model } : {})
  });
}

function parseJson(content: string, label: string) {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`${label} returned malformed JSON.`);
  }
}

function annotationMessages(works: LexicalBlockWork[]) {
  return [{
    role: "system" as const,
    content: [
      "You create original TOEFL lexical annotations for exact canonical English text.",
      "Return strict JSON matching the supplied schema and no prose.",
      "Annotate every supplied token candidate exactly once. Never add, omit, split, merge, or reorder token IDs.",
      "Use concise Simplified Chinese for the current contextual meaning and an original concise English definition for the current sense.",
      "Use the natural lemma/base form. Token expression_type is word unless the single token is genuinely a proper noun.",
      "Function words must still be annotated accurately and briefly.",
      "Expressions are optional Layer 2 learning units only: fixed phrases, common collocations, phrasal verbs, idioms, conventional academic/writing expressions, or multiword proper names.",
      "Do not emit arbitrary n-grams or ordinary compositional adjective+noun sequences. Expression spans must use exact UTF-16 offsets and exact source slices.",
      "For inflected expressions use a natural base canonical_expression and lemma while preserving source surface offsets.",
      "Set needs_review only for real POS, sense, lemma/base, boundary, proper-noun, or source uncertainty. Explain it briefly in review_notes; otherwise null.",
      "Do not copy commercial dictionary wording."
    ].join(" ")
  }, {
    role: "user" as const,
    content: JSON.stringify({
      schema_version: "lexical-annotation-v1",
      blocks: works.map((work) => ({
        block_key: lexicalBlockKey(work),
        source_type: work.block.sourceType,
        block_kind: work.block.blockKind,
        text: work.block.text,
        tokens: work.tokens.filter((token) => !token.excluded).map((token) => ({
          candidate_id: token.candidateId,
          surface_text: token.surfaceText,
          start_offset: token.startOffset,
          end_offset: token.endOffset,
          source_anchor_id: token.sourceAnchorId,
          source_review_reason: token.sourceReviewReason
        }))
      }))
    })
  }];
}

export async function requestLexicalAnnotations(
  config: WritingReviewProviderConfig,
  works: LexicalBlockWork[],
  options: {
    request?: StructuredRequest;
    timeoutMs?: number;
  } = {}
): Promise<{ occurrences: LexicalOccurrenceArtifact[]; model: string; usage: unknown }> {
  const reasoningEffort = process.env.LEXICAL_REASONING_EFFORT === "none" ? undefined : "high" as const;
  const response = await (options.request ?? requestWritingReviewStructuredOutput)(
    config,
    annotationMessages(works),
    {
      jsonSchema: LEXICAL_ANNOTATION_JSON_SCHEMA,
      schemaName: "tps_lexical_annotation_v1",
      ...(reasoningEffort ? { reasoningEffort } : {}),
      maxTokens: Number(process.env.LEXICAL_ANNOTATION_MAX_TOKENS ?? 16_384),
      timeoutMs: options.timeoutMs ?? 240_000,
      timeoutMessage: "Lexical annotation batch timed out."
    }
  );
  const occurrences = validateAnnotationBatch(works, parseJson(response.content, "Lexical annotation provider"));
  return { occurrences, model: response.model, usage: response.usage };
}

function enrichmentMessages(entries: ConsolidatedEntrySeed[]) {
  return [{
    role: "system" as const,
    content: [
      "You enrich consolidated TOEFL lexical entries using original wording.",
      "Return strict JSON matching the supplied schema and no prose. Return every entry_key exactly once.",
      "Provide 1-4 useful common senses ordered by TOEFL learning value. Keep POS explicit, English definitions original and concise, and Chinese meanings concise.",
      "derived_words must contain only genuine derivational or word-family relations, never inflections, synonyms, antonyms, or merely related words. Leave empty when uncertain.",
      "useful_patterns must be short, productive patterns directly tied to the entry. Function words and proper nouns usually have none.",
      "Preserve correct proper-noun capitalization. Normalize inflected words and expressions to natural base forms.",
      "Do not change an entry to a different normalized identity. canonical_expression and lemma must normalize to the supplied normalized_expression and expression_type.",
      "Set needs_review only for real consolidation, lemma, entity, sense, derivation, or enrichment uncertainty.",
      "Do not copy wording from commercial dictionaries."
    ].join(" ")
  }, {
    role: "user" as const,
    content: JSON.stringify({
      schema_version: "lexical-enrichment-v1",
      entries: entries.map((entry) => ({
        entry_key: entry.entry_key,
        normalized_expression: entry.normalized_expression,
        expression_type: entry.expression_type,
        proposed_canonical_expression: entry.canonical_expression,
        proposed_lemma: entry.lemma,
        source_types: Array.from(new Set(entry.sample_occurrences.map((value) => value.source_type))),
        samples: entry.sample_occurrences.map((value) => ({
          surface_text: value.surface_text,
          context_pos: value.context_pos,
          context_meaning_zh: value.context_meaning_zh,
          context_definition_en: value.context_definition_en,
          context_text: value.context_text,
          block_kind: value.content_block_id
        }))
      }))
    })
  }];
}

export async function requestLexicalEntryEnrichment(
  config: WritingReviewProviderConfig,
  entries: ConsolidatedEntrySeed[],
  options: {
    request?: StructuredRequest;
    timeoutMs?: number;
  } = {}
) {
  const reasoningEffort = process.env.LEXICAL_REASONING_EFFORT === "none" ? undefined : "high" as const;
  const response = await (options.request ?? requestWritingReviewStructuredOutput)(
    config,
    enrichmentMessages(entries),
    {
      jsonSchema: LEXICAL_ENRICHMENT_JSON_SCHEMA,
      schemaName: "tps_lexical_enrichment_v1",
      ...(reasoningEffort ? { reasoningEffort } : {}),
      maxTokens: Number(process.env.LEXICAL_ENRICHMENT_MAX_TOKENS ?? 12_000),
      timeoutMs: options.timeoutMs ?? 240_000,
      timeoutMessage: "Lexical entry enrichment batch timed out."
    }
  );
  return {
    entries: applyEntryEnrichment(entries, parseJson(response.content, "Lexical enrichment provider")),
    model: response.model,
    usage: response.usage
  };
}
