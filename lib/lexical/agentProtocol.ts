import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateAnnotationBatch, lexicalBlockKey } from "./annotation.ts";
import { applyEntryEnrichment, consolidateLexicalEntries, type ConsolidatedEntrySeed } from "./consolidate.ts";
import {
  LEXICAL_GENERATION_VERSION,
  type LexicalBlockWork,
  type LexicalOccurrenceArtifact,
  type LexicalTokenCandidate
} from "./generationTypes.ts";
import {
  LEXICAL_AGENT_PROVENANCE,
  LEXICAL_CURRENT_AGENT_PROVENANCE,
  lexicalSemanticProvenanceMatches,
  type LexicalSemanticProvenance
} from "./provenance.ts";
import type { CanonicalLexicalBlock, CanonicalLexicalSourceType } from "./types.ts";

export const LEXICAL_AGENT_PROTOCOL_VERSION = "lexical-agent-v1";
export const LEXICAL_AGENT_ANNOTATION_SCHEMA_VERSION = "lexical-agent-annotation-v1";
export const LEXICAL_AGENT_MWE_SCHEMA_VERSION = "lexical-agent-mwe-v1";
export const LEXICAL_AGENT_ENRICHMENT_SCHEMA_VERSION = "lexical-agent-enrichment-v1";
export const LEXICAL_AGENT_BATCH_PLAN_V1 = "lexical-agent-batch-plan-v1";
export const LEXICAL_AGENT_BATCH_PLAN_V2 = "lexical-agent-batch-plan-v2";

export type LexicalAgentStage = "annotation" | "mwe" | "enrichment";

export type LexicalAgentBatchPlan = {
  version: typeof LEXICAL_AGENT_BATCH_PLAN_V1 | typeof LEXICAL_AGENT_BATCH_PLAN_V2;
  annotationAcceptedPrefixBatches: number;
  acceptedAnnotationBatchIds: string[];
  maxTokens: number;
  maxBlocks: number;
};

const DEFAULT_AGENT_BATCH_PLAN: LexicalAgentBatchPlan = {
  version: LEXICAL_AGENT_BATCH_PLAN_V1,
  annotationAcceptedPrefixBatches: 0,
  acceptedAnnotationBatchIds: [],
  maxTokens: 80,
  maxBlocks: 3
};

type AgentPaths = ReturnType<typeof lexicalAgentPaths>;

export type LexicalAgentBatchSpec = {
  batchId: string;
  stage: LexicalAgentStage;
  index: number;
  total: number;
  sourceType: CanonicalLexicalSourceType | null;
  inputSignature: string;
  planVersion: LexicalAgentBatchPlan["version"];
  works?: LexicalBlockWork[];
  entries?: ConsolidatedEntrySeed[];
};

export function lexicalAgentBatchIdFromArgs(args: string[]) {
  return args.find((value) => value !== "--") ?? null;
}

export type AgentActiveBatch = {
  protocol_version: typeof LEXICAL_AGENT_PROTOCOL_VERSION;
  batch_id: string;
  stage: LexicalAgentStage;
  index: number;
  total: number;
  source_type: CanonicalLexicalSourceType | null;
  input_signature: string;
  provenance?: LexicalSemanticProvenance;
  batch_plan_version?: LexicalAgentBatchPlan["version"];
  input_path: string;
  output_path: string;
  prepared_at: string;
};

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown) {
  return JSON.stringify(value);
}

export function lexicalAgentPaths(root = process.cwd()) {
  const outputRoot = path.join(root, "tmp", "lexical-v1");
  const agentRoot = path.join(outputRoot, "agent-batches");
  return {
    root,
    outputRoot,
    agentRoot,
    pendingDir: path.join(agentRoot, "pending"),
    acceptedDir: path.join(agentRoot, "accepted"),
    rejectedDir: path.join(agentRoot, "rejected"),
    checkpointRoot: path.join(outputRoot, "checkpoints", "agent"),
    activeLock: path.join(agentRoot, "active-batch.json"),
    manifest: path.join(outputRoot, "generation-manifest.json"),
    batchPlan: path.join(agentRoot, "batch-plan.json"),
    canonicalBlocks: path.join(outputRoot, "canonical-blocks.jsonl"),
    tokenCandidates: path.join(outputRoot, "token-candidates.jsonl")
  };
}

async function ensureAgentDirectories(paths: AgentPaths) {
  await Promise.all([
    mkdir(paths.pendingDir, { recursive: true }),
    mkdir(paths.acceptedDir, { recursive: true }),
    mkdir(paths.rejectedDir, { recursive: true }),
    ...(["annotation", "mwe", "enrichment"] as LexicalAgentStage[]).map((stage) =>
      mkdir(path.join(paths.checkpointRoot, stage), { recursive: true })
    )
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

async function readJsonIfExists(filePath: string) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonl(filePath: string) {
  const contents = await readFile(filePath, "utf8");
  return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function loadLexicalAgentBatchPlan(root = process.cwd()): Promise<LexicalAgentBatchPlan> {
  const raw = await readJsonIfExists(lexicalAgentPaths(root).batchPlan);
  if (!raw) return DEFAULT_AGENT_BATCH_PLAN;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid lexical agent batch plan.");
  const record = raw as Record<string, unknown>;
  if (record.plan_version !== LEXICAL_AGENT_BATCH_PLAN_V2) throw new Error("Unsupported lexical agent batch plan version.");
  if (!Number.isInteger(record.annotation_accepted_prefix_batches) || Number(record.annotation_accepted_prefix_batches) < 1) {
    throw new Error("Invalid accepted annotation prefix in lexical agent batch plan.");
  }
  if (!Array.isArray(record.accepted_annotation_batch_ids) || record.accepted_annotation_batch_ids.some((value) => typeof value !== "string")) {
    throw new Error("Invalid accepted batch identities in lexical agent batch plan.");
  }
  if (record.accepted_annotation_batch_ids.length !== record.annotation_accepted_prefix_batches) {
    throw new Error("Accepted annotation prefix count does not match its batch identities.");
  }
  if (record.max_tokens !== 80 || record.max_blocks !== 6) throw new Error("Unexpected lexical agent v2 packing limits.");
  return {
    version: LEXICAL_AGENT_BATCH_PLAN_V2,
    annotationAcceptedPrefixBatches: Number(record.annotation_accepted_prefix_batches),
    acceptedAnnotationBatchIds: record.accepted_annotation_batch_ids as string[],
    maxTokens: Number(record.max_tokens),
    maxBlocks: Number(record.max_blocks)
  };
}

export async function loadLexicalAgentCorpus(root = process.cwd()) {
  const paths = lexicalAgentPaths(root);
  const [rawBlocks, rawTokens] = await Promise.all([
    readJsonl(paths.canonicalBlocks),
    readJsonl(paths.tokenCandidates)
  ]);
  const tokensByBlock = new Map<string, LexicalTokenCandidate[]>();
  for (const raw of rawTokens) {
    const token = raw as unknown as LexicalTokenCandidate;
    const key = `${token.sourceType}:${token.sourceItemId}:${token.contentBlockId}`;
    tokensByBlock.set(key, [...(tokensByBlock.get(key) ?? []), token]);
  }
  return rawBlocks.map((raw) => {
    const block: CanonicalLexicalBlock = {
      sourceType: raw.source_type as CanonicalLexicalSourceType,
      sourceItemId: String(raw.source_item_id),
      contentBlockId: String(raw.content_block_id),
      blockKind: String(raw.block_kind),
      text: String(raw.text),
      anchors: Array.isArray(raw.anchors) ? raw.anchors as CanonicalLexicalBlock["anchors"] : []
    };
    const key = `${block.sourceType}:${block.sourceItemId}:${block.contentBlockId}`;
    return {
      block,
      sourceTextHash: String(raw.source_text_hash),
      tokens: tokensByBlock.get(key) ?? []
    } satisfies LexicalBlockWork;
  });
}

function batchWorks(works: LexicalBlockWork[], maxTokens = 80, maxBlocks = 3) {
  const result: LexicalBlockWork[][] = [];
  let current: LexicalBlockWork[] = [];
  let tokenCount = 0;
  for (const work of works) {
    const eligible = work.tokens.filter((token) => !token.excluded).length;
    if (current.length && (current.length >= maxBlocks || tokenCount + eligible > maxTokens)) {
      result.push(current);
      current = [];
      tokenCount = 0;
    }
    current.push(work);
    tokenCount += eligible;
  }
  if (current.length) result.push(current);
  return result;
}

function workInputIdentity(work: LexicalBlockWork) {
  return {
    generation_version: LEXICAL_GENERATION_VERSION,
    source_type: work.block.sourceType,
    source_item_id: work.block.sourceItemId,
    content_block_id: work.block.contentBlockId,
    block_kind: work.block.blockKind,
    source_text_hash: work.sourceTextHash,
    text: work.block.text,
    eligible_tokens: work.tokens.filter((token) => !token.excluded).map((token) => ({
      candidate_id: token.candidateId,
      surface_text: token.surfaceText,
      start_offset: token.startOffset,
      end_offset: token.endOffset,
      source_anchor_id: token.sourceAnchorId,
      sentence_id: token.sentenceId,
      source_review_reason: token.sourceReviewReason
    })),
    excluded_spans: work.tokens.filter((token) => token.excluded).map((token) => ({
      surface_text: token.surfaceText,
      start_offset: token.startOffset,
      end_offset: token.endOffset,
      exclusion_reason: token.exclusionReason
    }))
  };
}

function createBatchId(
  stage: LexicalAgentStage,
  inputSignature: string,
  provenance: LexicalSemanticProvenance = LEXICAL_AGENT_PROVENANCE
) {
  return `${stage}-${sha256(stableJson({ stage, inputSignature, provenance })).slice(0, 20)}`;
}

export function buildLexicalAgentWorkBatchSpecs(
  works: LexicalBlockWork[],
  stage: "annotation" | "mwe",
  provenance: LexicalSemanticProvenance = LEXICAL_AGENT_PROVENANCE,
  plan: LexicalAgentBatchPlan = DEFAULT_AGENT_BATCH_PLAN
) {
  const sourceTypes = Array.from(new Set(works.map((work) => work.block.sourceType))) as CanonicalLexicalSourceType[];
  const legacyBatches = sourceTypes
    .flatMap((sourceType) => batchWorks(works.filter((work) => work.block.sourceType === sourceType)));
  const legacySpecs = legacyBatches.map((batch, index) =>
    buildWorkBatchSpec(batch, stage, index, legacyBatches.length, provenance, DEFAULT_AGENT_BATCH_PLAN)
  );
  if (plan.version === LEXICAL_AGENT_BATCH_PLAN_V1) return legacySpecs;

  const prefix = plan.annotationAcceptedPrefixBatches;
  if (prefix > legacyBatches.length) throw new Error("Accepted annotation prefix exceeds the legacy batch plan.");
  const actualPrefixIds = legacySpecs.slice(0, prefix).map((spec) => spec.batchId);
  if (stage === "annotation" && actualPrefixIds.some((batchId, index) => batchId !== plan.acceptedAnnotationBatchIds[index])) {
    throw new Error("Accepted annotation batch identity changed under the v2 plan.");
  }
  const acceptedBlockKeys = new Set(legacyBatches.slice(0, prefix).flat().map(lexicalBlockKey));
  const pendingWorks = works.filter((work) => !acceptedBlockKeys.has(lexicalBlockKey(work)));
  const pendingBatches = sourceTypes.flatMap((sourceType) =>
    batchWorks(
      pendingWorks.filter((work) => work.block.sourceType === sourceType),
      plan.maxTokens,
      plan.maxBlocks
    )
  );
  const total = prefix + pendingBatches.length;
  const pendingSpecs = pendingBatches.map((batch, offset) =>
    buildWorkBatchSpec(batch, stage, prefix + offset, total, provenance, plan)
  );
  if (stage === "annotation") return [...legacySpecs.slice(0, prefix), ...pendingSpecs];
  const prefixSpecs = legacyBatches.slice(0, prefix).map((batch, index) =>
    buildWorkBatchSpec(batch, stage, index, total, provenance, plan)
  );
  return [...prefixSpecs, ...pendingSpecs];
}

function buildWorkBatchSpec(
  batch: LexicalBlockWork[],
  stage: "annotation" | "mwe",
  index: number,
  total: number,
  provenance: LexicalSemanticProvenance,
  plan: LexicalAgentBatchPlan
) {
  const inputSignature = sha256(stableJson({
    protocol: LEXICAL_AGENT_PROTOCOL_VERSION,
    schema: stage === "annotation" ? LEXICAL_AGENT_ANNOTATION_SCHEMA_VERSION : LEXICAL_AGENT_MWE_SCHEMA_VERSION,
    provenance,
    ...(plan.version === LEXICAL_AGENT_BATCH_PLAN_V2 ? { batch_plan_version: plan.version } : {}),
    blocks: batch.map(workInputIdentity)
  }));
  return {
    batchId: createBatchId(stage, inputSignature, provenance),
    stage,
    index,
    total,
    sourceType: batch[0]?.block.sourceType ?? null,
    inputSignature,
    planVersion: plan.version,
    works: batch
  } satisfies LexicalAgentBatchSpec;
}

export function buildLexicalAgentEnrichmentBatchSpecs(
  entries: ConsolidatedEntrySeed[],
  provenance: LexicalSemanticProvenance = LEXICAL_AGENT_PROVENANCE,
  batchSize = 8,
  plan: LexicalAgentBatchPlan = DEFAULT_AGENT_BATCH_PLAN
) {
  const batches: ConsolidatedEntrySeed[][] = [];
  for (let index = 0; index < entries.length; index += batchSize) batches.push(entries.slice(index, index + batchSize));
  return batches.map((batch, index) => {
    const inputSignature = sha256(stableJson({
      protocol: LEXICAL_AGENT_PROTOCOL_VERSION,
      schema: LEXICAL_AGENT_ENRICHMENT_SCHEMA_VERSION,
      provenance,
      ...(plan.version === LEXICAL_AGENT_BATCH_PLAN_V2 ? { batch_plan_version: plan.version } : {}),
      entries: batch.map((entry) => ({
        entry_key: entry.entry_key,
        canonical_expression: entry.canonical_expression,
        normalized_expression: entry.normalized_expression,
        expression_type: entry.expression_type,
        lemma: entry.lemma,
        review_status: entry.review_status,
        review_notes: entry.review_notes,
        sample_occurrences: entry.sample_occurrences
      }))
    }));
    return {
      batchId: createBatchId("enrichment", inputSignature, provenance),
      stage: "enrichment",
      index,
      total: batches.length,
      sourceType: null,
      inputSignature,
      planVersion: plan.version,
      entries: batch
    } satisfies LexicalAgentBatchSpec;
  });
}

function checkpointPath(paths: AgentPaths, spec: LexicalAgentBatchSpec) {
  return path.join(paths.checkpointRoot, spec.stage, `${spec.batchId}.json`);
}

async function checkpointAccepted(paths: AgentPaths, spec: LexicalAgentBatchSpec) {
  const checkpoint = await readJsonIfExists(checkpointPath(paths, spec));
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return false;
  const record = checkpoint as Record<string, unknown>;
  return record.protocol_version === LEXICAL_AGENT_PROTOCOL_VERSION &&
    record.batch_id === spec.batchId &&
    record.input_signature === spec.inputSignature &&
    (lexicalSemanticProvenanceMatches(record.provenance) ||
      lexicalSemanticProvenanceMatches(record.provenance, LEXICAL_CURRENT_AGENT_PROVENANCE)) &&
    (spec.planVersion === LEXICAL_AGENT_BATCH_PLAN_V1
      ? record.batch_plan_version === undefined || record.batch_plan_version === LEXICAL_AGENT_BATCH_PLAN_V1
      : record.batch_plan_version === spec.planVersion);
}

export function annotationInput(spec: LexicalAgentBatchSpec) {
  return {
    protocol_version: LEXICAL_AGENT_PROTOCOL_VERSION,
    batch_id: spec.batchId,
    stage: spec.stage,
    provenance: LEXICAL_CURRENT_AGENT_PROVENANCE,
    generation_version: LEXICAL_GENERATION_VERSION,
    schema_version: spec.stage === "annotation" ? LEXICAL_AGENT_ANNOTATION_SCHEMA_VERSION : LEXICAL_AGENT_MWE_SCHEMA_VERSION,
    input_signature: spec.inputSignature,
    ...(spec.planVersion === LEXICAL_AGENT_BATCH_PLAN_V2 ? { batch_plan_version: spec.planVersion } : {}),
    source_type: spec.sourceType,
    batch_index: spec.index,
    total_batches: spec.total,
    blocks: spec.works!.map(workInputIdentity)
  };
}

function enrichmentInput(spec: LexicalAgentBatchSpec) {
  return {
    protocol_version: LEXICAL_AGENT_PROTOCOL_VERSION,
    batch_id: spec.batchId,
    stage: spec.stage,
    provenance: LEXICAL_CURRENT_AGENT_PROVENANCE,
    generation_version: LEXICAL_GENERATION_VERSION,
    schema_version: LEXICAL_AGENT_ENRICHMENT_SCHEMA_VERSION,
    input_signature: spec.inputSignature,
    ...(spec.planVersion === LEXICAL_AGENT_BATCH_PLAN_V2 ? { batch_plan_version: spec.planVersion } : {}),
    batch_index: spec.index,
    total_batches: spec.total,
    entries: spec.entries!.map((entry) => ({
      entry_key: entry.entry_key,
      normalized_expression: entry.normalized_expression,
      expression_type: entry.expression_type,
      proposed_canonical_expression: entry.canonical_expression,
      proposed_lemma: entry.lemma,
      review_status: entry.review_status,
      review_notes: entry.review_notes,
      samples: entry.sample_occurrences
    }))
  };
}

async function loadAcceptedOccurrences(paths: AgentPaths, specs: LexicalAgentBatchSpec[], stage: "annotation" | "mwe") {
  const occurrences: LexicalOccurrenceArtifact[] = [];
  for (const spec of specs) {
    const checkpoint = await readJsonIfExists(checkpointPath(paths, spec)) as { occurrences?: LexicalOccurrenceArtifact[] } | null;
    if (!checkpoint?.occurrences) throw new Error(`Missing accepted ${stage} checkpoint ${spec.batchId}.`);
    occurrences.push(...checkpoint.occurrences);
  }
  return occurrences;
}

async function nextMissingSpec(paths: AgentPaths, specs: LexicalAgentBatchSpec[]) {
  for (const spec of specs) if (!await checkpointAccepted(paths, spec)) return spec;
  return null;
}

function agentManifestWork(
  sourceTypes: CanonicalLexicalSourceType[],
  spec: LexicalAgentBatchSpec | null
) {
  if (!spec) {
    return { completedSourceTypes: sourceTypes, remainingWork: ["qa", "artifacts"] };
  }
  if (spec.stage === "enrichment") {
    return { completedSourceTypes: sourceTypes, remainingWork: ["enrichment", "qa", "artifacts"] };
  }
  const sourceIndex = spec.sourceType ? sourceTypes.indexOf(spec.sourceType) : 0;
  const pendingSourceTypes = sourceTypes.slice(Math.max(0, sourceIndex));
  return {
    completedSourceTypes: spec.stage === "mwe" ? sourceTypes.slice(0, Math.max(0, sourceIndex)) : [],
    remainingWork: [
      ...pendingSourceTypes,
      ...(spec.stage === "annotation" ? ["mwe"] : []),
      "consolidation",
      "enrichment",
      "qa",
      "artifacts"
    ]
  };
}

async function updateManifest(
  paths: AgentPaths,
  sourceTypes: CanonicalLexicalSourceType[],
  spec: LexicalAgentBatchSpec | null,
  completed: number,
  pending: number
) {
  const raw = await readJsonIfExists(paths.manifest);
  const manifest = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const work = agentManifestWork(sourceTypes, spec);
  manifest.execution_model = "openai/gpt-6-sol high";
  manifest.semantic_engine = LEXICAL_CURRENT_AGENT_PROVENANCE.semantic_engine;
  manifest.annotation_provider = LEXICAL_CURRENT_AGENT_PROVENANCE.provider;
  manifest.annotation_model = LEXICAL_CURRENT_AGENT_PROVENANCE.model;
  manifest.thinking_effort = LEXICAL_CURRENT_AGENT_PROVENANCE.thinking_effort;
  manifest.provenance = LEXICAL_CURRENT_AGENT_PROVENANCE;
  manifest.prompt_schema_versions = {
    annotation: LEXICAL_AGENT_ANNOTATION_SCHEMA_VERSION,
    mwe: LEXICAL_AGENT_MWE_SCHEMA_VERSION,
    enrichment: LEXICAL_AGENT_ENRICHMENT_SCHEMA_VERSION
  };
  manifest.complete = false;
  manifest.import_ready = false;
  manifest.phase = spec ? `agent_${spec.stage}` : "agent_finalize_ready";
  manifest.completed_source_types = work.completedSourceTypes;
  manifest.current_source_type = spec?.sourceType ?? null;
  manifest.current_batch_index = spec?.index ?? null;
  manifest.remaining_work = work.remainingWork;
  manifest.stop_reason = null;
  const previousGeneration = manifest.generation && typeof manifest.generation === "object" && !Array.isArray(manifest.generation)
    ? manifest.generation as Record<string, unknown>
    : {};
  manifest.generation = {
    annotation_batches_completed: spec?.stage === "annotation"
      ? completed
      : spec?.stage === "mwe"
        ? spec.total
        : Number(previousGeneration.annotation_batches_completed ?? 0),
    annotation_batches_cached: 0,
    annotation_model_failures: 0,
    enrichment_entries_completed: 0,
    enrichment_entries_cached: 0,
    enrichment_model_failures: 0
  };
  manifest.agent_progress = {
    stage: spec?.stage ?? "finalize",
    active_batch_id: spec?.batchId ?? null,
    completed_batches: completed,
    pending_batches: pending,
    next_batch_index: spec?.index ?? null,
    source_type: spec?.sourceType ?? null
  };
  manifest.updated_at = new Date().toISOString();
  await writeJson(paths.manifest, manifest);
}

export async function markLexicalAgentBatchAcceptedInManifest(
  accepted: AgentActiveBatch,
  root = process.cwd()
) {
  const paths = lexicalAgentPaths(root);
  const raw = await readJsonIfExists(paths.manifest);
  const manifest = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const completed = accepted.index + 1;
  const pending = Math.max(0, accepted.total - completed);
  manifest.complete = false;
  manifest.import_ready = false;
  manifest.phase = `agent_${accepted.stage}_checkpointed`;
  manifest.current_source_type = accepted.source_type;
  manifest.current_batch_index = null;
  manifest.stop_reason = null;
  const previousGeneration = manifest.generation && typeof manifest.generation === "object" && !Array.isArray(manifest.generation)
    ? manifest.generation as Record<string, unknown>
    : {};
  manifest.generation = {
    ...previousGeneration,
    ...(accepted.stage === "annotation" ? { annotation_batches_completed: completed } : {}),
    annotation_batches_cached: 0,
    annotation_model_failures: 0,
    enrichment_entries_cached: 0,
    enrichment_model_failures: 0
  };
  manifest.agent_progress = {
    stage: accepted.stage,
    active_batch_id: null,
    completed_batches: completed,
    pending_batches: pending,
    next_batch_index: pending ? completed : null,
    source_type: accepted.source_type
  };
  manifest.updated_at = new Date().toISOString();
  await writeJson(paths.manifest, manifest);
}

export async function prepareNextLexicalAgentBatch(root = process.cwd()) {
  const paths = lexicalAgentPaths(root);
  const coordinator = await readJsonIfExists(paths.manifest) as Record<string, unknown> | null;
  if (coordinator?.parallel_plan_version && coordinator.phase !== "agent_annotation_merged") {
    throw new Error("Annotation is owned by the parallel coordinator; specify a shard.");
  }
  await ensureAgentDirectories(paths);
  const active = await readJsonIfExists(paths.activeLock) as AgentActiveBatch | null;
  if (active) return active;

  const works = await loadLexicalAgentCorpus(root);
  const plan = await loadLexicalAgentBatchPlan(root);
  const sourceTypes = Array.from(new Set(works.map((work) => work.block.sourceType)));
  const annotationSpecs = buildLexicalAgentWorkBatchSpecs(works, "annotation", LEXICAL_AGENT_PROVENANCE, plan);
  let spec = await nextMissingSpec(paths, annotationSpecs);
  let completed = spec ? spec.index : annotationSpecs.length;
  let pending = annotationSpecs.length - completed;

  if (!spec) {
    const mweSpecs = buildLexicalAgentWorkBatchSpecs(works, "mwe", LEXICAL_AGENT_PROVENANCE, plan);
    spec = await nextMissingSpec(paths, mweSpecs);
    completed = spec ? spec.index : mweSpecs.length;
    pending = mweSpecs.length - completed;
    if (!spec) {
      const occurrences = await loadAcceptedOccurrences(paths, mweSpecs, "mwe");
      const seeds = consolidateLexicalEntries(occurrences);
      const enrichmentSpecs = buildLexicalAgentEnrichmentBatchSpecs(seeds, LEXICAL_AGENT_PROVENANCE, 8, plan);
      spec = await nextMissingSpec(paths, enrichmentSpecs);
      completed = spec ? spec.index : enrichmentSpecs.length;
      pending = enrichmentSpecs.length - completed;
    }
  }

  if (!spec) {
    await updateManifest(paths, sourceTypes, null, completed, 0);
    return null;
  }

  const inputPath = path.join(paths.pendingDir, `${spec.batchId}.input.json`);
  const outputPath = path.join(paths.pendingDir, `${spec.batchId}.output.json`);
  await writeJson(inputPath, spec.stage === "enrichment" ? enrichmentInput(spec) : annotationInput(spec));
  const activeBatch: AgentActiveBatch = {
    protocol_version: LEXICAL_AGENT_PROTOCOL_VERSION,
    batch_id: spec.batchId,
    stage: spec.stage,
    index: spec.index,
    total: spec.total,
    source_type: spec.sourceType,
    input_signature: spec.inputSignature,
    provenance: LEXICAL_CURRENT_AGENT_PROVENANCE,
    ...(spec.planVersion === LEXICAL_AGENT_BATCH_PLAN_V2 ? { batch_plan_version: spec.planVersion } : {}),
    input_path: path.relative(root, inputPath),
    output_path: path.relative(root, outputPath),
    prepared_at: new Date().toISOString()
  };
  await writeJson(paths.activeLock, activeBatch);
  await updateManifest(paths, sourceTypes, spec, completed, pending);
  return activeBatch;
}

function validateEnvelope(output: Record<string, unknown>, active: AgentActiveBatch) {
  if (output.protocol_version !== LEXICAL_AGENT_PROTOCOL_VERSION) throw new Error("Agent output protocol_version mismatch.");
  if (output.batch_id !== active.batch_id) throw new Error("Agent output batch_id mismatch.");
  if (output.stage !== active.stage) throw new Error("Agent output stage mismatch.");
  if (output.input_signature !== active.input_signature) throw new Error("Agent output input_signature mismatch.");
  if (active.batch_plan_version && output.batch_plan_version !== active.batch_plan_version) {
    throw new Error("Agent output batch_plan_version mismatch.");
  }
  if (!lexicalSemanticProvenanceMatches(output.provenance, active.provenance ?? LEXICAL_AGENT_PROVENANCE)) {
    throw new Error("Agent output provenance mismatch.");
  }
}

function tokenAnnotationsFromOccurrences(works: LexicalBlockWork[], occurrences: LexicalOccurrenceArtifact[]) {
  return works.map((work) => ({
    block_key: lexicalBlockKey(work),
    tokens: work.tokens.filter((token) => !token.excluded).map((token) => {
      const occurrence = occurrences.find((value) =>
        value.layer === 1 &&
        value.source_type === token.sourceType &&
        value.source_item_id === token.sourceItemId &&
        value.content_block_id === token.contentBlockId &&
        value.start_offset === token.startOffset &&
        value.end_offset === token.endOffset
      );
      if (!occurrence) throw new Error(`Missing accepted token occurrence ${token.candidateId}.`);
      return {
        candidate_id: token.candidateId,
        context_pos: occurrence.context_pos,
        context_meaning_zh: occurrence.context_meaning_zh,
        context_definition_en: occurrence.context_definition_en,
        canonical_expression: occurrence.canonical_expression,
        lemma: occurrence.lemma,
        expression_type: occurrence.expression_type,
        needs_review: occurrence.review_status === "needs_review",
        review_notes: occurrence.review_notes
      };
    }),
    expressions: [] as unknown[]
  }));
}

export async function acceptLexicalAgentBatch(batchId: string, root = process.cwd()) {
  const paths = lexicalAgentPaths(root);
  const coordinator = await readJsonIfExists(paths.manifest) as Record<string, unknown> | null;
  if (coordinator?.parallel_plan_version && coordinator.phase !== "agent_annotation_merged") {
    throw new Error("Annotation is owned by the parallel coordinator; specify a shard.");
  }
  await ensureAgentDirectories(paths);
  const active = await readJsonIfExists(paths.activeLock) as AgentActiveBatch | null;
  if (!active) throw new Error("No active lexical agent batch.");
  if (active.batch_id !== batchId) throw new Error(`Active batch is ${active.batch_id}, not ${batchId}.`);
  const outputPath = path.join(root, active.output_path);
  const output = await readJsonIfExists(outputPath);
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error(`Missing agent output ${active.output_path}.`);
  validateEnvelope(output as Record<string, unknown>, active);

  const works = await loadLexicalAgentCorpus(root);
  const plan = await loadLexicalAgentBatchPlan(root);
  const workSpecs = active.stage === "enrichment"
    ? []
    : buildLexicalAgentWorkBatchSpecs(works, active.stage, LEXICAL_AGENT_PROVENANCE, plan);
  const spec = active.stage === "enrichment"
    ? null
    : workSpecs.find((value) => value.batchId === batchId) ?? null;
  let checkpoint: Record<string, unknown>;

  if (active.stage === "annotation") {
    if (!spec || !Array.isArray((output as Record<string, unknown>).blocks)) throw new Error("Invalid annotation batch output.");
    const blocks = ((output as Record<string, unknown>).blocks as Array<Record<string, unknown>>).map((block) => ({
      ...block,
      expressions: []
    }));
    const occurrences = validateAnnotationBatch(spec.works!, { blocks });
    checkpoint = { ...active, provenance: active.provenance ?? LEXICAL_AGENT_PROVENANCE, accepted_at: new Date().toISOString(), occurrences };
  } else if (active.stage === "mwe") {
    if (!spec || !Array.isArray((output as Record<string, unknown>).blocks)) throw new Error("Invalid MWE batch output.");
    const annotationSpecs = buildLexicalAgentWorkBatchSpecs(works, "annotation", LEXICAL_AGENT_PROVENANCE, plan);
    const annotationSpec = annotationSpecs[spec.index];
    const annotationCheckpoint = await readJsonIfExists(checkpointPath(paths, annotationSpec)) as { occurrences?: LexicalOccurrenceArtifact[] } | null;
    if (!annotationCheckpoint?.occurrences) throw new Error(`Missing annotation checkpoint ${annotationSpec.batchId}.`);
    const tokenBlocks = tokenAnnotationsFromOccurrences(spec.works!, annotationCheckpoint.occurrences);
    const expressionsByKey = new Map(((output as Record<string, unknown>).blocks as Array<Record<string, unknown>>).map((block) => [
      block.block_key,
      block.expressions
    ]));
    const combined = tokenBlocks.map((block) => ({ ...block, expressions: expressionsByKey.get(block.block_key) ?? [] }));
    const occurrences = validateAnnotationBatch(spec.works!, { blocks: combined });
    checkpoint = {
      ...active,
      provenance: active.provenance ?? LEXICAL_AGENT_PROVENANCE,
      accepted_at: new Date().toISOString(),
      mwe_detection_executed: true,
      occurrences
    };
  } else {
    const mweSpecs = buildLexicalAgentWorkBatchSpecs(works, "mwe", LEXICAL_AGENT_PROVENANCE, plan);
    const occurrences = await loadAcceptedOccurrences(paths, mweSpecs, "mwe");
    const seeds = consolidateLexicalEntries(occurrences);
    const enrichmentSpecs = buildLexicalAgentEnrichmentBatchSpecs(seeds, LEXICAL_AGENT_PROVENANCE, 8, plan);
    const enrichmentSpec = enrichmentSpecs.find((value) => value.batchId === batchId);
    if (!enrichmentSpec) throw new Error(`Unknown enrichment batch ${batchId}.`);
    const entries = applyEntryEnrichment(enrichmentSpec.entries!, { entries: (output as Record<string, unknown>).entries });
    checkpoint = { ...active, provenance: active.provenance ?? LEXICAL_AGENT_PROVENANCE, accepted_at: new Date().toISOString(), entries };
  }

  const stageCheckpoint = path.join(paths.checkpointRoot, active.stage, `${active.batch_id}.json`);
  await writeJson(stageCheckpoint, checkpoint);
  const acceptedStageDir = path.join(paths.acceptedDir, active.stage);
  await mkdir(acceptedStageDir, { recursive: true });
  await rename(path.join(root, active.input_path), path.join(acceptedStageDir, `${active.batch_id}.input.json`));
  await rename(outputPath, path.join(acceptedStageDir, `${active.batch_id}.output.json`));
  await unlink(paths.activeLock);
  await markLexicalAgentBatchAcceptedInManifest(active, root);
  return checkpoint;
}

export async function lexicalAgentCheckpointCounts(root = process.cwd()) {
  const paths = lexicalAgentPaths(root);
  const works = await loadLexicalAgentCorpus(root);
  const plan = await loadLexicalAgentBatchPlan(root);
  const annotation = buildLexicalAgentWorkBatchSpecs(works, "annotation", LEXICAL_AGENT_PROVENANCE, plan);
  const mwe = buildLexicalAgentWorkBatchSpecs(works, "mwe", LEXICAL_AGENT_PROVENANCE, plan);
  const count = async (specs: LexicalAgentBatchSpec[]) => {
    let completed = 0;
    for (const spec of specs) {
      if (!await checkpointAccepted(paths, spec)) break;
      completed += 1;
    }
    return { completed, total: specs.length, pending: specs.length - completed };
  };
  return { annotation: await count(annotation), mwe: await count(mwe) };
}

export async function loadCompletedLexicalAgentData(root = process.cwd()) {
  const paths = lexicalAgentPaths(root);
  const works = await loadLexicalAgentCorpus(root);
  const plan = await loadLexicalAgentBatchPlan(root);
  const annotationSpecs = buildLexicalAgentWorkBatchSpecs(works, "annotation", LEXICAL_AGENT_PROVENANCE, plan);
  const mweSpecs = buildLexicalAgentWorkBatchSpecs(works, "mwe", LEXICAL_AGENT_PROVENANCE, plan);
  for (const spec of [...annotationSpecs, ...mweSpecs]) {
    if (!await checkpointAccepted(paths, spec)) throw new Error(`Semantic stage is incomplete at ${spec.batchId}.`);
  }
  const occurrences = await loadAcceptedOccurrences(paths, mweSpecs, "mwe");
  const seeds = consolidateLexicalEntries(occurrences);
  const enrichmentSpecs = buildLexicalAgentEnrichmentBatchSpecs(seeds, LEXICAL_AGENT_PROVENANCE, 8, plan);
  const entries: ConsolidatedEntrySeed[] = [];
  for (const spec of enrichmentSpecs) {
    if (!await checkpointAccepted(paths, spec)) throw new Error(`Semantic stage is incomplete at ${spec.batchId}.`);
    const checkpoint = await readJsonIfExists(checkpointPath(paths, spec)) as { entries?: ConsolidatedEntrySeed[] } | null;
    if (!checkpoint?.entries) throw new Error(`Missing accepted enrichment checkpoint ${spec.batchId}.`);
    entries.push(...checkpoint.entries);
  }
  return {
    works,
    occurrences,
    entries: seeds.map((seed) => entries.find((entry) => entry.entry_key === seed.entry_key)!),
    stageCounts: {
      annotation: annotationSpecs.length,
      mwe: mweSpecs.length,
      enrichment: enrichmentSpecs.length
    }
  };
}
