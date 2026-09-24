import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  lexicalAnnotationBatchCacheKey,
  lexicalBlockCacheIdentity,
  lexicalEntryEnrichmentCacheKey,
  lexicalEntryEnrichmentInputSignature,
  annotationCacheMatches,
  enrichmentCacheMatches
} from "../lib/lexical/cache.ts";
import {
  consolidateLexicalEntries,
  mergeCachedEntryEnrichment,
  type ConsolidatedEntrySeed
} from "../lib/lexical/consolidate.ts";
import { assessLexicalCompletion } from "../lib/lexical/completion.ts";
import { enumerateCanonicalLexicalBlocks } from "../lib/lexical/enumerateCanonicalBlocks.server.ts";
import {
  LEXICAL_GENERATION_VERSION,
  lexicalEntryKey,
  type LexicalBlockWork,
  type LexicalEntryArtifact,
  type LexicalOccurrenceArtifact
} from "../lib/lexical/generationTypes.ts";
import { loadCanonicalLexicalInputs } from "../lib/lexical/loadCanonicalInputs.server.ts";
import { normalizeLexicalExpression } from "../lib/lexical/normalize.ts";
import {
  getLexicalProviderConfig,
  requestLexicalAnnotations,
  requestLexicalEntryEnrichment
} from "../lib/lexical/provider.server.ts";
import { annotationCacheNeedsRecovery, annotationOccurrencesNeedRecovery } from "../lib/lexical/semantic.ts";
import { qaEntries, qaLexicalBlock, qaOccurrenceSemantics, type LexicalBlockQa } from "../lib/lexical/qa.ts";
import { tokenizeCanonicalBlocks } from "../lib/lexical/tokenize.ts";
import type { CanonicalLexicalSourceType } from "../lib/lexical/types.ts";
import { createServiceSupabase } from "../lib/supabase/server.ts";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const OUTPUT_DIR = path.join(ROOT, "tmp", "lexical-v1");
const ANNOTATION_CACHE_DIR = path.join(OUTPUT_DIR, "checkpoints", "annotation");
const ENRICHMENT_CACHE_DIR = path.join(OUTPUT_DIR, "checkpoints", "enrichment");
const SOURCE_TYPES: CanonicalLexicalSourceType[] = [
  "ctw",
  "rdl",
  "rap",
  "bas",
  "write_email",
  "academic_discussion"
];

type Manifest = {
  generation_version: string;
  run_started_at: string;
  updated_at: string;
  execution_model: string;
  annotation_provider: string | null;
  annotation_model: string | null;
  prompt_schema_versions: { annotation: string; enrichment: string };
  git_commit: string | null;
  complete: boolean;
  import_ready: boolean;
  phase: string;
  completed_source_types: CanonicalLexicalSourceType[];
  current_source_type: CanonicalLexicalSourceType | null;
  current_batch_index: number | null;
  remaining_work: string[];
  stop_reason: string | null;
  semantic_audit: {
    audited_at: string;
    occurrence_issue_records: number;
    occurrence_issue_counts: Record<string, number>;
    entry_issue_records: number;
    entry_issue_counts: Record<string, number>;
  } | null;
  blocking_issues: {
    annotation_model_failure_occurrences: number;
    mwe_model_failure_blocks: number;
    enrichment_model_failure_entries: number;
    structural_qa_failure_blocks: number;
    semantic_qa_issue_occurrences: number;
    semantic_qa_issue_entries: number;
    unsafe_recovery_blocks: number;
  };
  corpus_counts: Record<string, unknown>;
  generation: {
    annotation_batches_completed: number;
    annotation_batches_cached: number;
    annotation_model_failures: number;
    enrichment_entries_completed: number;
    enrichment_entries_cached: number;
    enrichment_model_failures: number;
  };
};

function now() {
  return new Date().toISOString();
}

async function ensureDirectories() {
  await Promise.all([
    mkdir(OUTPUT_DIR, { recursive: true }),
    mkdir(ANNOTATION_CACHE_DIR, { recursive: true }),
    mkdir(ENRICHMENT_CACHE_DIR, { recursive: true })
  ]);
}

async function writeAtomic(filePath: string, contents: string) {
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, filePath);
}

async function writeJson(filePath: string, value: unknown) {
  await writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeJsonl(filePath: string, values: unknown[]) {
  await writeAtomic(filePath, values.map((value) => JSON.stringify(value)).join("\n") + (values.length ? "\n" : ""));
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeCsv(filePath: string, headers: string[], rows: Array<Record<string, unknown>>) {
  const lines = [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))];
  await writeAtomic(filePath, `${lines.join("\n")}\n`);
}

async function readJsonIfExists(filePath: string) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function gitCommit() {
  try {
    return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ROOT })).stdout.trim() || null;
  } catch {
    return null;
  }
}

function batchWorks(works: LexicalBlockWork[], maxTokens: number, maxBlocks: number) {
  const batches: LexicalBlockWork[][] = [];
  let current: LexicalBlockWork[] = [];
  let tokenCount = 0;
  for (const work of works) {
    const workTokens = work.tokens.filter((token) => !token.excluded).length;
    if (current.length && (current.length >= maxBlocks || tokenCount + workTokens > maxTokens)) {
      batches.push(current);
      current = [];
      tokenCount = 0;
    }
    current.push(work);
    tokenCount += workTokens;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T, index: number) => Promise<R>) {
  const results = new Array<R>(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function fallbackOccurrences(work: LexicalBlockWork, reason: string): LexicalOccurrenceArtifact[] {
  return work.tokens.filter((token) => !token.excluded).map((token) => {
    const canonicalExpression = token.normalizedSurface;
    const normalizedExpression = normalizeLexicalExpression(canonicalExpression, "word");
    return {
      entry_key: lexicalEntryKey(normalizedExpression, "word"),
      source_type: token.sourceType,
      source_item_id: token.sourceItemId,
      content_block_id: token.contentBlockId,
      sentence_id: token.sentenceId,
      source_anchor_id: token.sourceAnchorId,
      surface_text: token.surfaceText,
      normalized_surface: token.normalizedSurface,
      start_offset: token.startOffset,
      end_offset: token.endOffset,
      context_pos: "other",
      context_meaning_zh: `待人工确认：${token.surfaceText}`,
      context_definition_en: `The contextual meaning of ${JSON.stringify(token.surfaceText)} requires review.`,
      context_text: work.block.text,
      review_status: "needs_review",
      generation_version: LEXICAL_GENERATION_VERSION,
      review_notes: reason,
      layer: 1,
      expression_type: "word",
      canonical_expression: canonicalExpression,
      normalized_expression: normalizedExpression,
      lemma: normalizedExpression
    };
  });
}

async function main() {
  const enumerateOnly = process.argv.includes("--enumerate-only");
  if (!enumerateOnly) {
    throw new Error("External-provider lexical semantic generation is disabled. Use lexical:agent-next and lexical:agent-accept with the current OpenChamber GPT-5.6 Sol High agent.");
  }
  await ensureDirectories();
  const existingManifest = await readJsonIfExists(path.join(OUTPUT_DIR, "generation-manifest.json")) as Manifest | null;
  const manifest: Manifest = existingManifest?.generation_version === LEXICAL_GENERATION_VERSION
    ? existingManifest
    : {
        generation_version: LEXICAL_GENERATION_VERSION,
        run_started_at: now(),
        updated_at: now(),
        execution_model: "openai/gpt-5.6-sol high",
        annotation_provider: null,
        annotation_model: null,
        prompt_schema_versions: { annotation: "lexical-annotation-v1", enrichment: "lexical-enrichment-v1" },
        git_commit: await gitCommit(),
        complete: false,
        import_ready: false,
        phase: "enumeration",
        completed_source_types: [],
        current_source_type: null,
        current_batch_index: null,
        remaining_work: [...SOURCE_TYPES, "consolidation", "enrichment", "qa", "artifacts"],
        stop_reason: null,
        semantic_audit: null,
        blocking_issues: {
          annotation_model_failure_occurrences: 0,
          mwe_model_failure_blocks: 0,
          enrichment_model_failure_entries: 0,
          structural_qa_failure_blocks: 0,
          semantic_qa_issue_occurrences: 0,
          semantic_qa_issue_entries: 0,
          unsafe_recovery_blocks: 0
        },
        corpus_counts: {},
        generation: {
          annotation_batches_completed: 0,
          annotation_batches_cached: 0,
          annotation_model_failures: 0,
          enrichment_entries_completed: 0,
          enrichment_entries_cached: 0,
          enrichment_model_failures: 0
        }
      };
  manifest.complete = false;
  manifest.import_ready = false;
  manifest.stop_reason = null;
  manifest.semantic_audit = null;
  manifest.blocking_issues = {
    annotation_model_failure_occurrences: 0,
    mwe_model_failure_blocks: 0,
    enrichment_model_failure_entries: 0,
    structural_qa_failure_blocks: 0,
    semantic_qa_issue_occurrences: 0,
    semantic_qa_issue_entries: 0,
    unsafe_recovery_blocks: 0
  };
  manifest.completed_source_types = manifest.completed_source_types.filter((value) => SOURCE_TYPES.includes(value));
  manifest.current_source_type = null;
  manifest.current_batch_index = null;
  manifest.remaining_work = [...SOURCE_TYPES, "consolidation", "enrichment", "qa", "artifacts"];
  manifest.generation = {
    annotation_batches_completed: 0,
    annotation_batches_cached: 0,
    annotation_model_failures: 0,
    enrichment_entries_completed: 0,
    enrichment_entries_cached: 0,
    enrichment_model_failures: 0
  };
  let manifestWriteQueue = Promise.resolve();
  const flushManifest = () => {
    manifest.updated_at = now();
    manifestWriteQueue = manifestWriteQueue.then(() =>
      writeJson(path.join(OUTPUT_DIR, "generation-manifest.json"), manifest)
    );
    return manifestWriteQueue;
  };
  await flushManifest();

  console.log("Loading all canonical source data with read-only SELECT operations...");
  const input = await loadCanonicalLexicalInputs(createServiceSupabase(), {
    assetBaseUrl: process.env.READING_ASSET_BASE_URL,
    onProgress: (message) => console.log(message)
  });
  const blocks = enumerateCanonicalLexicalBlocks(input);
  const works = tokenizeCanonicalBlocks(blocks);
  const itemCounts = Object.fromEntries(SOURCE_TYPES.map((sourceType) => [
    sourceType,
    new Set(blocks.filter((block) => block.sourceType === sourceType).map((block) => block.sourceItemId)).size
  ]));
  manifest.corpus_counts = {
    items: itemCounts,
    blocks: blocks.length,
    eligible_tokens: works.reduce((sum, work) => sum + work.tokens.filter((token) => !token.excluded).length, 0),
    excluded_tokens: works.reduce((sum, work) => sum + work.tokens.filter((token) => token.excluded).length, 0),
    by_source_type: Object.fromEntries(SOURCE_TYPES.map((sourceType) => {
      const sourceWorks = works.filter((work) => work.block.sourceType === sourceType);
      return [sourceType, {
        items: itemCounts[sourceType],
        blocks: sourceWorks.length,
        eligible_tokens: sourceWorks.reduce((sum, work) => sum + work.tokens.filter((token) => !token.excluded).length, 0),
        excluded_tokens: sourceWorks.reduce((sum, work) => sum + work.tokens.filter((token) => token.excluded).length, 0)
      }];
    }))
  };
  await Promise.all([
    writeJsonl(path.join(OUTPUT_DIR, "canonical-blocks.jsonl"), blocks.map((block) => ({
      source_type: block.sourceType,
      source_item_id: block.sourceItemId,
      content_block_id: block.contentBlockId,
      block_kind: block.blockKind,
      source_text_hash: works.find((work) => work.block === block)!.sourceTextHash,
      text: block.text,
      anchors: block.anchors ?? []
    }))),
    writeJsonl(path.join(OUTPUT_DIR, "token-candidates.jsonl"), works.flatMap((work) => work.tokens))
  ]);
  manifest.phase = enumerateOnly ? "enumeration_complete" : "annotation";
  await flushManifest();
  console.log(`Enumerated ${blocks.length} blocks and ${String(manifest.corpus_counts.eligible_tokens)} eligible tokens.`);
  if (enumerateOnly) return;

  if (process.env.LEXICAL_RECOVERY_MODE) {
    throw new Error("LEXICAL_RECOVERY_MODE is no longer supported; resume uses context-safe block annotation and selectively retries invalid caches.");
  }

  const providerConfig = getLexicalProviderConfig();
  manifest.annotation_provider = providerConfig.provider;
  manifest.annotation_model = providerConfig.model;
  const maxTokens = Number(process.env.LEXICAL_ANNOTATION_BATCH_TOKENS ?? 240);
  const maxBlocks = Number(process.env.LEXICAL_ANNOTATION_BATCH_BLOCKS ?? 10);
  const concurrency = Number(process.env.LEXICAL_CONCURRENCY ?? 3);
  const allOccurrences: LexicalOccurrenceArtifact[] = [];
  const annotationFailures = new Map<string, string>();
  const annotateWithRecovery = async (batch: LexicalBlockWork[]): Promise<LexicalOccurrenceArtifact[]> => {
    const cacheKey = lexicalAnnotationBatchCacheKey(batch);
    const cachePath = path.join(ANNOTATION_CACHE_DIR, `${cacheKey}.json`);
    const cached = await readJsonIfExists(cachePath) as {
      generation_version?: unknown;
      blocks?: unknown;
      recovered_by_lexeme?: unknown;
      occurrences?: LexicalOccurrenceArtifact[];
    } | null;
    const cachedHasFallback = cached ? annotationCacheNeedsRecovery(cached) : false;
    if (cached && annotationCacheMatches(cached, batch) && Array.isArray(cached.occurrences) && !cachedHasFallback) {
      manifest.generation.annotation_batches_cached += 1;
      return cached.occurrences;
    }
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await requestLexicalAnnotations(providerConfig, batch);
        manifest.annotation_model = result.model;
        await writeJson(cachePath, {
          generation_version: LEXICAL_GENERATION_VERSION,
          blocks: batch.map(lexicalBlockCacheIdentity),
          model: result.model,
          usage: result.usage,
          occurrences: result.occurrences
        });
        return result.occurrences;
      } catch (error) {
        lastError = error;
        console.warn(`Annotation attempt ${attempt} failed for ${batch.length} block(s): ${(error as Error).message}`);
      }
    }
    manifest.generation.annotation_model_failures += 1;
    if (batch.length > 1) {
      const middle = Math.ceil(batch.length / 2);
      const occurrences = [
        ...await annotateWithRecovery(batch.slice(0, middle)),
        ...await annotateWithRecovery(batch.slice(middle))
      ];
      await writeJson(cachePath, {
        generation_version: LEXICAL_GENERATION_VERSION,
        blocks: batch.map(lexicalBlockCacheIdentity),
        model: manifest.annotation_model,
        recovered_by_split: true,
        occurrences
      });
      return occurrences;
    }
    const reason = `model_schema_failure: ${(lastError as Error)?.message ?? "unknown annotation failure"}`;
    const fallback = fallbackOccurrences(batch[0], reason);
    annotationFailures.set(`${batch[0].block.sourceType}:${batch[0].block.sourceItemId}:${batch[0].block.contentBlockId}`, reason);
    await writeJson(cachePath, {
      generation_version: LEXICAL_GENERATION_VERSION,
      blocks: batch.map(lexicalBlockCacheIdentity),
      model: manifest.annotation_model,
      fallback: true,
      failure: reason,
      occurrences: fallback
    });
    return fallback;
  };

  for (let sourceIndex = 0; sourceIndex < SOURCE_TYPES.length; sourceIndex += 1) {
    const sourceType = SOURCE_TYPES[sourceIndex];
    manifest.current_source_type = sourceType;
    manifest.completed_source_types = manifest.completed_source_types.filter((value) => value !== sourceType);
    manifest.remaining_work = [sourceType, ...SOURCE_TYPES.slice(sourceIndex + 1), "consolidation", "enrichment", "qa", "artifacts"];
    await flushManifest();
    const sourceWorks = works.filter((work) => work.block.sourceType === sourceType);
    const batches = batchWorks(sourceWorks, maxTokens, maxBlocks);
    const completedBatchIndexes = new Set<number>();
    let contiguousBatchCount = 0;
    console.log(`Annotating ${sourceType}: ${sourceWorks.length} blocks in ${batches.length} batches.`);
    const batchResults = await mapWithConcurrency(batches, concurrency, async (batch, index) => {
      const occurrences = await annotateWithRecovery(batch);
      completedBatchIndexes.add(index);
      while (completedBatchIndexes.has(contiguousBatchCount)) contiguousBatchCount += 1;
      manifest.current_batch_index = contiguousBatchCount - 1;
      manifest.generation.annotation_batches_completed += 1;
      await flushManifest();
      console.log(`${sourceType} batch ${index + 1}/${batches.length} checkpointed.`);
      return occurrences;
    });
    allOccurrences.push(...batchResults.flat());
    manifest.completed_source_types.push(sourceType);
    manifest.current_batch_index = null;
    manifest.remaining_work = [
      ...SOURCE_TYPES.slice(sourceIndex + 1),
      "consolidation",
      "enrichment",
      "qa",
      "artifacts"
    ];
    await flushManifest();
  }

  manifest.phase = "consolidation";
  manifest.current_source_type = null;
  await flushManifest();
  const seeds = consolidateLexicalEntries(allOccurrences);
  console.log(`Consolidated ${allOccurrences.length} occurrences into ${seeds.length} entry seeds.`);

  manifest.phase = "enrichment";
  await flushManifest();
  const enrichedByKey = new Map<string, ConsolidatedEntrySeed>();
  let missingSeeds: ConsolidatedEntrySeed[] = [];
  for (const seed of seeds) {
    const cachePath = path.join(ENRICHMENT_CACHE_DIR, `${lexicalEntryEnrichmentCacheKey(seed)}.json`);
    const cached = await readJsonIfExists(cachePath) as {
      generation_version?: unknown;
      normalized_expression?: unknown;
      expression_type?: unknown;
      input_signature?: unknown;
      entry?: ConsolidatedEntrySeed;
    } | null;
    const mergedCachedEntry = cached?.entry ? mergeCachedEntryEnrichment(seed, cached.entry) : null;
    const cachedHasFallback = cached?.entry?.review_notes?.includes("enrichment_model_failure") ||
      (mergedCachedEntry ? qaEntries([mergedCachedEntry]).length > 0 : false);
    if (cached && enrichmentCacheMatches(cached, seed) && mergedCachedEntry && !cachedHasFallback) {
      enrichedByKey.set(seed.entry_key, mergedCachedEntry);
      manifest.generation.enrichment_entries_cached += 1;
    } else {
      missingSeeds.push(seed);
    }
  }

  if (process.env.LEXICAL_ENRICHMENT_MODE === "contextual_priority") {
    const priorityLimit = Number(process.env.LEXICAL_ENRICHMENT_PRIORITY_LIMIT ?? 1_200);
    const productiveSources = new Set(["bas", "write_email", "academic_discussion"]);
    const prioritized = [...missingSeeds].sort((left, right) => {
      const score = (entry: ConsolidatedEntrySeed) =>
        (entry.expression_type === "word" ? 0 : 100) +
        (entry.expression_type === "proper_noun" ? 40 : 0) +
        (entry.sample_occurrences.some((occurrence) => productiveSources.has(occurrence.source_type)) ? 20 : 0) +
        Math.min(entry.canonical_expression.length, 15);
      return score(right) - score(left) || left.entry_key.localeCompare(right.entry_key);
    });
    const modelKeys = new Set(prioritized.slice(0, priorityLimit).map((entry) => entry.entry_key));
    const contextualEntries = missingSeeds.filter((entry) =>
      !modelKeys.has(entry.entry_key) &&
      !annotationOccurrencesNeedRecovery(entry.sample_occurrences)
    ).map((entry) => {
      const senses = Array.from(new Map(entry.sample_occurrences.map((occurrence) => [
        `${occurrence.context_pos}\u0000${occurrence.context_definition_en}\u0000${occurrence.context_meaning_zh}`,
        {
          pos: occurrence.context_pos,
          definition_en: occurrence.context_definition_en,
          meaning_zh: occurrence.context_meaning_zh
        }
      ])).values()).slice(0, 4);
      return {
        ...entry,
        common_senses: senses.length ? senses : [{
          pos: "other" as const,
          definition_en: `The meaning of ${JSON.stringify(entry.canonical_expression)} requires review.`,
          meaning_zh: `待人工确认：${entry.canonical_expression}`
        }],
        derived_words: [],
        useful_patterns: [],
        review_status: entry.review_status,
        review_notes: entry.review_notes
      };
    });
    for (const entry of contextualEntries) {
      enrichedByKey.set(entry.entry_key, entry);
      await writeJson(path.join(ENRICHMENT_CACHE_DIR, `${lexicalEntryEnrichmentCacheKey(entry)}.json`), {
        generation_version: LEXICAL_GENERATION_VERSION,
        normalized_expression: entry.normalized_expression,
        expression_type: entry.expression_type,
        input_signature: lexicalEntryEnrichmentInputSignature(entry),
        contextual_consolidation: true,
        entry
      });
    }
    const contextuallyEnrichedKeys = new Set(contextualEntries.map((entry) => entry.entry_key));
    missingSeeds = missingSeeds.filter((entry) => !contextuallyEnrichedKeys.has(entry.entry_key));
    console.log(`Contextually enriched ${contextualEntries.length} entries; ${missingSeeds.length} priority entries require model enrichment.`);
  }

  const checkpointEnrichedEntries = async (
    entries: ConsolidatedEntrySeed[],
    inputSeeds: ConsolidatedEntrySeed[]
  ) => {
    const inputByKey = new Map(inputSeeds.map((entry) => [entry.entry_key, entry]));
    await Promise.all(entries.map((entry) =>
      writeJson(path.join(ENRICHMENT_CACHE_DIR, `${lexicalEntryEnrichmentCacheKey(entry)}.json`), {
        generation_version: LEXICAL_GENERATION_VERSION,
        normalized_expression: entry.normalized_expression,
        expression_type: entry.expression_type,
        input_signature: lexicalEntryEnrichmentInputSignature(inputByKey.get(entry.entry_key) ?? entry),
        entry
      })
    ));
  };

  const enrichWithRecovery = async (batch: ConsolidatedEntrySeed[]): Promise<ConsolidatedEntrySeed[]> => {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await requestLexicalEntryEnrichment(providerConfig, batch);
        manifest.annotation_model = result.model;
        await checkpointEnrichedEntries(result.entries, batch);
        return result.entries;
      } catch (error) {
        lastError = error;
        console.warn(`Enrichment attempt ${attempt} failed for ${batch.length} entries: ${(error as Error).message}`);
      }
    }
    manifest.generation.enrichment_model_failures += 1;
    if (batch.length > 1) {
      const middle = Math.ceil(batch.length / 2);
      return [
        ...await enrichWithRecovery(batch.slice(0, middle)),
        ...await enrichWithRecovery(batch.slice(middle))
      ];
    }
    const seed = batch[0];
    const sample = seed.sample_occurrences[0];
    const note = `enrichment_model_failure: ${(lastError as Error)?.message ?? "unknown enrichment failure"}`;
    const fallback: ConsolidatedEntrySeed[] = [{
      ...seed,
      common_senses: [{
        pos: sample.context_pos,
        definition_en: sample.context_definition_en,
        meaning_zh: sample.context_meaning_zh
      }],
      derived_words: [],
      useful_patterns: [],
      review_status: "needs_review",
      review_notes: [seed.review_notes, note].filter(Boolean).join("; ")
    }];
    await checkpointEnrichedEntries(fallback, [seed]);
    return fallback;
  };

  const enrichmentBatches: ConsolidatedEntrySeed[][] = [];
  const enrichmentBatchSize = Number(process.env.LEXICAL_ENRICHMENT_BATCH_SIZE ?? 50);
  for (let index = 0; index < missingSeeds.length; index += enrichmentBatchSize) {
    enrichmentBatches.push(missingSeeds.slice(index, index + enrichmentBatchSize));
  }
  const completedEnrichmentBatchIndexes = new Set<number>();
  let contiguousEnrichmentBatchCount = 0;
  const enrichmentResults = await mapWithConcurrency(enrichmentBatches, concurrency, async (batch, batchIndex) => {
    const entries = await enrichWithRecovery(batch);
    manifest.generation.enrichment_entries_completed += entries.length;
    completedEnrichmentBatchIndexes.add(batchIndex);
    while (completedEnrichmentBatchIndexes.has(contiguousEnrichmentBatchCount)) contiguousEnrichmentBatchCount += 1;
    manifest.current_batch_index = contiguousEnrichmentBatchCount - 1;
    await flushManifest();
    console.log(`Enrichment batch ${batchIndex + 1}/${enrichmentBatches.length} checkpointed.`);
    return entries;
  });
  for (const entry of enrichmentResults.flat()) enrichedByKey.set(entry.entry_key, entry);
  const enrichedEntries = seeds.map((seed) => enrichedByKey.get(seed.entry_key)!);

  manifest.phase = "qa";
  manifest.current_batch_index = null;
  await flushManifest();
  const entryIssues = qaEntries(enrichedEntries);
  const occurrenceSemanticIssues = qaOccurrenceSemantics(allOccurrences);
  const countReasons = (issues: Array<{ reasons: string[] }>) => {
    const counts: Record<string, number> = {};
    for (const issue of issues) {
      for (const reason of Array.from(new Set(issue.reasons))) counts[reason] = (counts[reason] ?? 0) + 1;
    }
    return counts;
  };
  const semanticAudit = {
    audited_at: now(),
    occurrence_issue_records: occurrenceSemanticIssues.length,
    occurrence_issue_counts: countReasons(occurrenceSemanticIssues),
    entry_issue_records: entryIssues.length,
    entry_issue_counts: countReasons(entryIssues)
  };
  const entryIssueByKey = new Map(entryIssues.map((issue) => [issue.entryKey, issue.reasons]));
  for (const entry of enrichedEntries) {
    const reasons = entryIssueByKey.get(entry.entry_key);
    if (reasons?.length) {
      entry.review_status = "needs_review";
      entry.review_notes = [entry.review_notes, ...reasons].filter(Boolean).join("; ");
    }
  }
  const reviewEntryKeys = new Set(enrichedEntries.filter((entry) => entry.review_status === "needs_review").map((entry) => entry.entry_key));
  const blockKeyFor = (sourceType: string, sourceItemId: string, contentBlockId: string) =>
    `${sourceType}:${sourceItemId}:${contentBlockId}`;
  const occurrencesByBlock = new Map<string, LexicalOccurrenceArtifact[]>();
  for (const occurrence of allOccurrences) {
    const key = blockKeyFor(occurrence.source_type, occurrence.source_item_id, occurrence.content_block_id);
    occurrencesByBlock.set(key, [...(occurrencesByBlock.get(key) ?? []), occurrence]);
  }
  const blockQa: LexicalBlockQa[] = works.map((work) => {
    const key = blockKeyFor(work.block.sourceType, work.block.sourceItemId, work.block.contentBlockId);
    const blockOccurrences = occurrencesByBlock.get(key) ?? [];
    const qa = qaLexicalBlock(work, blockOccurrences, null);
    if (qa.generationStatus !== "failed" && blockOccurrences.some((occurrence) => reviewEntryKeys.has(occurrence.entry_key))) {
      qa.generationStatus = "needs_review";
      qa.reasons.push("entry_needs_review");
    }
    if (annotationFailures.has(key) && qa.generationStatus !== "failed") qa.generationStatus = "needs_review";
    return qa;
  });

  const sourceBlockArtifacts = works.map((work) => {
    const qa = blockQa.find((value) =>
      value.sourceType === work.block.sourceType &&
      value.sourceItemId === work.block.sourceItemId &&
      value.contentBlockId === work.block.contentBlockId
    )!;
    return {
      source_type: work.block.sourceType,
      source_item_id: work.block.sourceItemId,
      content_block_id: work.block.contentBlockId,
      block_kind: work.block.blockKind,
      source_text_hash: work.sourceTextHash,
      generation_status: qa.generationStatus,
      generation_version: LEXICAL_GENERATION_VERSION,
      last_error: qa.generationStatus === "failed" ? qa.reasons.join("; ") : null
    };
  });

  const cleanEntries: LexicalEntryArtifact[] = enrichedEntries.map((entry) => ({
    canonical_expression: entry.canonical_expression,
    normalized_expression: entry.normalized_expression,
    expression_type: entry.expression_type,
    lemma: entry.lemma,
    common_senses: entry.common_senses,
    derived_words: entry.derived_words,
    useful_patterns: entry.useful_patterns,
    review_status: entry.review_status,
    generation_version: LEXICAL_GENERATION_VERSION,
    review_notes: entry.review_notes
  }));
  const cleanOccurrences = allOccurrences.map((occurrence) => ({
    entry_key: occurrence.entry_key,
    source_type: occurrence.source_type,
    source_item_id: occurrence.source_item_id,
    content_block_id: occurrence.content_block_id,
    sentence_id: occurrence.sentence_id,
    source_anchor_id: occurrence.source_anchor_id,
    surface_text: occurrence.surface_text,
    normalized_surface: occurrence.normalized_surface,
    start_offset: occurrence.start_offset,
    end_offset: occurrence.end_offset,
    context_pos: occurrence.context_pos,
    context_meaning_zh: occurrence.context_meaning_zh,
    context_definition_en: occurrence.context_definition_en,
    context_text: occurrence.context_text,
    review_status: occurrence.review_status,
    generation_version: occurrence.generation_version,
    review_notes: occurrence.review_notes
  }));

  const needsReview: Array<Record<string, unknown>> = [];
  for (const entry of enrichedEntries.filter((value) => value.review_status === "needs_review")) {
    needsReview.push({
      record_type: "entry",
      category: classifyReview(entry.review_notes),
      entry_key: entry.entry_key,
      source_type: "",
      source_item_id: "",
      content_block_id: "",
      expression: entry.canonical_expression,
      reason: entry.review_notes
    });
  }
  for (const occurrence of allOccurrences.filter((value) => value.review_status === "needs_review")) {
    needsReview.push({
      record_type: "occurrence",
      category: classifyReview(occurrence.review_notes),
      entry_key: occurrence.entry_key,
      source_type: occurrence.source_type,
      source_item_id: occurrence.source_item_id,
      content_block_id: occurrence.content_block_id,
      expression: occurrence.surface_text,
      reason: occurrence.review_notes
    });
  }
  for (const qa of blockQa.filter((value) => value.generationStatus !== "generated")) {
    needsReview.push({
      record_type: "block",
      category: qa.generationStatus === "failed" ? "model/schema failure" : classifyReview(qa.reasons.join("; ")),
      entry_key: "",
      source_type: qa.sourceType,
      source_item_id: qa.sourceItemId,
      content_block_id: qa.contentBlockId,
      expression: "",
      reason: qa.reasons.join("; ")
    });
  }

  const bySourceType = SOURCE_TYPES.map((sourceType) => summarizeQa(
    sourceType,
    works.filter((work) => work.block.sourceType === sourceType),
    allOccurrences,
    blockQa,
    enrichedEntries
  ));
  const blockKinds = Array.from(new Set(works.map((work) => work.block.blockKind))).sort().map((blockKind) => {
    const kindWorks = works.filter((work) => work.block.blockKind === blockKind);
    const qas = blockQa.filter((qa) => qa.blockKind === blockKind);
    const kindBlockKeys = new Set(kindWorks.map((work) =>
      blockKeyFor(work.block.sourceType, work.block.sourceItemId, work.block.contentBlockId)
    ));
    const kindOccurrences = allOccurrences.filter((occurrence) => kindBlockKeys.has(
      blockKeyFor(occurrence.source_type, occurrence.source_item_id, occurrence.content_block_id)
    ));
    return {
      block_kind: blockKind,
      blocks: kindWorks.length,
      eligible_tokens: qas.reduce((sum, qa) => sum + qa.eligibleTokens, 0),
      excluded_tokens: qas.reduce((sum, qa) => sum + qa.excludedTokens, 0),
      layer_1: kindOccurrences.filter((occurrence) => occurrence.layer === 1).length,
      layer_2: kindOccurrences.filter((occurrence) => occurrence.layer === 2).length,
      needs_review_blocks: qas.filter((qa) => qa.generationStatus === "needs_review").length,
      failed_blocks: qas.filter((qa) => qa.generationStatus === "failed").length
    };
  });
  const qaSummary = {
    generation_version: LEXICAL_GENERATION_VERSION,
    generated_at: now(),
    overall: summarizeQa("overall", works, allOccurrences, blockQa, enrichedEntries),
    by_source_type: bySourceType,
    by_block_kind: blockKinds,
    expression_types: Object.fromEntries(["word", "phrase", "phrasal_verb", "idiom", "proper_noun"].map((type) => [
      type,
      allOccurrences.filter((occurrence) => occurrence.expression_type === type).length
    ])),
    entries_with_derived_words: enrichedEntries.filter((entry) => entry.derived_words.length > 0).length,
    entries_with_useful_patterns: enrichedEntries.filter((entry) => entry.useful_patterns.length > 0).length,
    semantic_audit: semanticAudit,
    entry_qa_issues: entryIssues,
    failed_blocks: blockQa.filter((qa) => qa.generationStatus === "failed")
  };

  manifest.phase = "artifacts";
  await Promise.all([
    writeJsonl(path.join(OUTPUT_DIR, "expression-candidates.jsonl"), allOccurrences.filter((occurrence) => occurrence.layer === 2)),
    writeJsonl(path.join(OUTPUT_DIR, "lexical-entries.jsonl"), cleanEntries),
    writeJsonl(path.join(OUTPUT_DIR, "lexical-occurrences.jsonl"), cleanOccurrences),
    writeJsonl(path.join(OUTPUT_DIR, "lexical-source-blocks.jsonl"), sourceBlockArtifacts),
    writeJsonl(path.join(OUTPUT_DIR, "needs-review.jsonl"), needsReview),
    writeCsv(path.join(OUTPUT_DIR, "needs-review.csv"), [
      "record_type", "category", "entry_key", "source_type", "source_item_id", "content_block_id", "expression", "reason"
    ], needsReview),
    writeJson(path.join(OUTPUT_DIR, "qa-summary.json"), qaSummary),
    writeCsv(path.join(OUTPUT_DIR, "qa-by-source-type.csv"), Object.keys(bySourceType[0]), bySourceType),
    writeCsv(path.join(OUTPUT_DIR, "qa-by-block-kind.csv"), Object.keys(blockKinds[0]), blockKinds)
  ]);
  const completion = assessLexicalCompletion(allOccurrences, enrichedEntries, blockQa);
  manifest.complete = completion.complete;
  manifest.import_ready = completion.complete;
  manifest.phase = completion.phase;
  manifest.current_source_type = null;
  manifest.current_batch_index = null;
  manifest.remaining_work = completion.remainingWork;
  manifest.stop_reason = completion.complete
    ? null
    : "Model-backed annotation, MWE detection, or enrichment fallbacks remain; checkpoints and artifacts are preserved for targeted resume.";
  manifest.blocking_issues = completion.blockingIssues;
  manifest.semantic_audit = semanticAudit;
  manifest.corpus_counts = { ...manifest.corpus_counts, qa: qaSummary };
  await flushManifest();
  console.log(completion.complete
    ? `Lexical V1 generation complete. Artifacts: ${OUTPUT_DIR}`
    : `Lexical V1 artifacts checkpointed with remaining work: ${completion.remainingWork.join(", ")}`
  );
}

function classifyReview(notes: string | null | undefined) {
  const value = notes?.toLocaleLowerCase("en-US") ?? "";
  if (value.includes("rdl_source")) return "RDL source";
  if (value.includes("pos")) return "POS";
  if (value.includes("lemma") || value.includes("base")) return "lemma/base";
  if (value.includes("boundary") || value.includes("mwe") || value.includes("phrase")) return "MWE boundary";
  if (value.includes("proper") || value.includes("entity")) return "proper noun";
  if (value.includes("merge") || value.includes("canonical")) return "merge conflict";
  if (value.includes("enrichment") || value.includes("derived") || value.includes("pattern")) return "enrichment";
  if (value.includes("model") || value.includes("schema")) return "model/schema failure";
  if (value.includes("sense")) return "sense";
  return "other";
}

function summarizeQa(
  sourceType: string,
  works: LexicalBlockWork[],
  occurrences: LexicalOccurrenceArtifact[],
  blockQa: LexicalBlockQa[],
  entries: ConsolidatedEntrySeed[]
) {
  const sourceOccurrences = sourceType === "overall" ? occurrences : occurrences.filter((value) => value.source_type === sourceType);
  const sourceQas = sourceType === "overall" ? blockQa : blockQa.filter((value) => value.sourceType === sourceType);
  const itemIds = new Set(works.map((work) => work.block.sourceItemId));
  const entryKeys = new Set(sourceOccurrences.map((occurrence) => occurrence.entry_key));
  return {
    source_type: sourceType,
    items: itemIds.size,
    blocks: works.length,
    eligible_tokens: sourceQas.reduce((sum, qa) => sum + qa.eligibleTokens, 0),
    excluded_tokens: sourceQas.reduce((sum, qa) => sum + qa.excludedTokens, 0),
    layer_1: sourceOccurrences.filter((occurrence) => occurrence.layer === 1).length,
    layer_2: sourceOccurrences.filter((occurrence) => occurrence.layer === 2).length,
    unique_entries: entryKeys.size,
    needs_review: sourceQas.filter((qa) => qa.generationStatus === "needs_review").length,
    failed_blocks: sourceQas.filter((qa) => qa.generationStatus === "failed").length,
    missing_tokens: sourceQas.reduce((sum, qa) => sum + qa.missingTokens, 0),
    invalid_spans: sourceQas.reduce((sum, qa) => sum + qa.invalidSpans, 0),
    duplicate_exact_spans: sourceQas.reduce((sum, qa) => sum + qa.duplicateExactSpans, 0),
    coverage_percent: sourceQas.reduce((sum, qa) => sum + qa.eligibleTokens, 0) === 0 ? 100 :
      sourceQas.reduce((sum, qa) => sum + qa.coveredLayer1, 0) /
      sourceQas.reduce((sum, qa) => sum + qa.eligibleTokens, 0) * 100,
    reviewed_entries: entries.filter((entry) => entryKeys.has(entry.entry_key) && entry.review_status === "needs_review").length
  };
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
