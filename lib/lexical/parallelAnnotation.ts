import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile, constants } from "node:fs/promises";
import path from "node:path";
import { annotationInput, buildLexicalAgentWorkBatchSpecs, lexicalAgentPaths, loadLexicalAgentBatchPlan, loadLexicalAgentCorpus, LEXICAL_AGENT_ANNOTATION_SCHEMA_VERSION, LEXICAL_AGENT_BATCH_PLAN_V2, LEXICAL_AGENT_PROTOCOL_VERSION, type LexicalAgentBatchSpec } from "./agentProtocol.ts";
import { validateAnnotationBatch } from "./annotation.ts";
import { LEXICAL_GENERATION_VERSION, type LexicalBlockWork, type LexicalOccurrenceArtifact } from "./generationTypes.ts";
import { LEXICAL_AGENT_PROVENANCE, LEXICAL_CURRENT_AGENT_PROVENANCE, lexicalSemanticProvenanceMatches } from "./provenance.ts";

export const LEXICAL_PARALLEL_PLAN_VERSION = "lexical-agent-parallel-plan-v1";
export const LEXICAL_PARALLEL_SHARD_COUNT = 8;

type Batch = {
  batch_id: string;
  batch_index: number;
  source_type: string;
  input_signature: string;
  occurrence_count: number;
  estimated_input_bytes: number;
  estimated_output_bytes: number;
  weight: number;
  input_sha256: string;
  work_sha256: string;
  shard_id: number;
};
type Shard = {
  shard_id: number;
  assigned_batch_ids: string[];
  batch_count: number;
  occurrence_count: number;
  estimated_input_bytes: number;
  estimated_output_bytes: number;
  cumulative_weight: number;
};
export type ParallelPlan = {
  parallel_plan_version: typeof LEXICAL_PARALLEL_PLAN_VERSION;
  batch_plan_version: typeof LEXICAL_AGENT_BATCH_PLAN_V2;
  generation_version: typeof LEXICAL_GENERATION_VERSION;
  provenance: typeof LEXICAL_CURRENT_AGENT_PROVENANCE;
  semantic_engine: string;
  provider: string;
  model: string;
  thinking_effort: string;
  created_from_manifest_sha256: string;
  batch_plan_sha256: string;
  canonical_blocks_sha256: string;
  token_candidates_sha256: string;
  accepted_batch_ids_excluded: string[];
  accepted_checkpoint_sha256: Record<string, string>;
  accepted_input_sha256: Record<string, string>;
  accepted_output_sha256: Record<string, string>;
  shard_count: 8;
  batches: Batch[];
  shards: Shard[];
  total_accepted_occurrences: number;
  total_pending_occurrences: number;
  full_workload_occurrences: number;
};
type ShardManifest = {
  parallel_plan_version: typeof LEXICAL_PARALLEL_PLAN_VERSION;
  plan_sha256: string;
  shard_id: number;
  shard_count: 8;
  batch_plan_version: typeof LEXICAL_AGENT_BATCH_PLAN_V2;
  phase: "pending" | "active" | "complete";
  complete: boolean;
  assigned_batch_count: number;
  accepted_batch_count: number;
  pending_batch_count: number;
  assigned_occurrence_count: number;
  accepted_occurrence_count: number;
  next_batch: string | null;
  active_batch_id: string | null;
  last_checkpoint: string | null;
  errors: string[];
};
type Active = {
  batch_id: string;
  shard_id: number;
  parallel_plan_version: typeof LEXICAL_PARALLEL_PLAN_VERSION;
  owner: string;
  input_path: string;
  output_path: string;
  prepared_at: string;
};

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, "utf8")) as T;
const exists = async (file: string) => stat(file).then(() => true, (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return false;
  throw error;
});
async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, json(value), { flag: "wx" });
    await rename(temporary, file);
  } finally {
    if (await exists(temporary)) await unlink(temporary);
  }
}
const parallelRoot = (root: string) => path.join(lexicalAgentPaths(root).outputRoot, "parallel-v1");
const shardRoot = (root: string, shard: number) => path.join(parallelRoot(root), `shard-${String(shard).padStart(2, "0")}`);
const planPath = (root: string) => path.join(parallelRoot(root), "plan.json");
const manifestPath = (root: string, shard: number) => path.join(shardRoot(root, shard), "manifest.json");
const lockPath = (root: string, shard: number) => path.join(shardRoot(root, shard), "active-batch.json");
const inputPath = (root: string, shard: number, id: string) => path.join(shardRoot(root, shard), "inputs", `${id}.input.json`);
const workPath = (root: string, shard: number, id: string) => path.join(shardRoot(root, shard), "inputs", `${id}.work.json`);
const pendingOutput = (root: string, shard: number, id: string) => path.join(shardRoot(root, shard), "pending", `${id}.output.json`);
const acceptedOutput = (root: string, shard: number, id: string) => path.join(shardRoot(root, shard), "outputs", `${id}.output.json`);
const checkpointPath = (root: string, shard: number, id: string) => path.join(shardRoot(root, shard), "checkpoints", `${id}.json`);
const occurrenceKey = (o: LexicalOccurrenceArtifact) => `${o.source_type}:${o.source_item_id}:${o.content_block_id}:${o.start_offset}:${o.end_offset}`;
const expectedTokens = (spec: LexicalAgentBatchSpec) => spec.works!.flatMap(work => work.tokens.filter(token => !token.excluded).map(token => token.candidateId));

export function balanceParallelBatches(items: Array<Omit<Batch, "shard_id">>): { batches: Batch[]; shards: Shard[] } {
  const shards: Shard[] = Array.from({ length: LEXICAL_PARALLEL_SHARD_COUNT }, (_, shard_id) => ({
    shard_id, assigned_batch_ids: [], batch_count: 0, occurrence_count: 0,
    estimated_input_bytes: 0, estimated_output_bytes: 0, cumulative_weight: 0
  }));
  const assignments = new Map<string, number>();
  for (const batch of [...items].sort((a, b) => b.weight - a.weight || a.batch_index - b.batch_index || a.batch_id.localeCompare(b.batch_id))) {
    const shard = shards.reduce((best, candidate) => candidate.cumulative_weight < best.cumulative_weight ? candidate : best);
    assignments.set(batch.batch_id, shard.shard_id);
    shard.batch_count++;
    shard.occurrence_count += batch.occurrence_count;
    shard.estimated_input_bytes += batch.estimated_input_bytes;
    shard.estimated_output_bytes += batch.estimated_output_bytes;
    shard.cumulative_weight += batch.weight;
  }
  const batches = items.map(batch => ({ ...batch, shard_id: assignments.get(batch.batch_id)! }));
  for (const batch of batches) shards[batch.shard_id].assigned_batch_ids.push(batch.batch_id);
  return { batches, shards };
}

async function acceptedSnapshot(root: string, specs: LexicalAgentBatchSpec[], count: number) {
  const paths = lexicalAgentPaths(root);
  const checkpointHashes: Record<string, string> = {};
  const inputHashes: Record<string, string> = {};
  const outputHashes: Record<string, string> = {};
  const ids = new Set<string>();
  for (const spec of specs.slice(0, count)) {
    const id = spec.batchId;
    const checkpointFile = path.join(paths.checkpointRoot, "annotation", `${id}.json`);
    const inputFile = path.join(paths.acceptedDir, "annotation", `${id}.input.json`);
    const outputFile = path.join(paths.acceptedDir, "annotation", `${id}.output.json`);
    const [checkpointBytes, inputBytes, outputBytes] = await Promise.all([readFile(checkpointFile), readFile(inputFile), readFile(outputFile)]);
    const checkpoint = JSON.parse(checkpointBytes.toString()) as { batch_id: string; input_signature: string; provenance: unknown; occurrences: LexicalOccurrenceArtifact[] };
    if (checkpoint.batch_id !== id || checkpoint.input_signature !== spec.inputSignature ||
        !(lexicalSemanticProvenanceMatches(checkpoint.provenance) || lexicalSemanticProvenanceMatches(checkpoint.provenance, LEXICAL_CURRENT_AGENT_PROVENANCE))) {
      throw new Error(`Invalid immutable accepted checkpoint ${id}.`);
    }
    const expected = expectedTokens(spec);
    if (checkpoint.occurrences?.length !== expected.length ||
        new Set(checkpoint.occurrences.map(occurrenceKey)).size !== expected.length ||
        checkpoint.occurrences.some(o => !expected.includes(occurrenceKey(o)))) {
      throw new Error(`Accepted occurrence boundary mismatch in ${id}.`);
    }
    for (const occurrence of checkpoint.occurrences) {
      const key = occurrenceKey(occurrence);
      if (ids.has(key)) throw new Error(`Duplicate accepted occurrence ${key}.`);
      ids.add(key);
    }
    checkpointHashes[id] = hash(checkpointBytes);
    inputHashes[id] = hash(inputBytes);
    outputHashes[id] = hash(outputBytes);
  }
  return { ids, checkpointHashes, inputHashes, outputHashes };
}

export function checkParallelCoverage(accepted: Iterable<string>, full: Iterable<string>, pending: Array<{ batch_id: string; shard_id: number; candidate_ids: string[] }>) {
  const acceptedSet = new Set(accepted);
  const fullSet = new Set(full);
  const seen = new Set(acceptedSet);
  const batchIds = new Set<string>();
  let duplicateBatches = 0;
  let duplicateOccurrences = 0;
  let acceptedOverlap = 0;
  let pairwiseOverlap = 0;
  const owners = new Map<string, number>();
  for (const batch of pending) {
    if (batchIds.has(batch.batch_id)) duplicateBatches++;
    batchIds.add(batch.batch_id);
    for (const id of batch.candidate_ids) {
      if (acceptedSet.has(id)) acceptedOverlap++;
      if (seen.has(id)) duplicateOccurrences++;
      if (owners.has(id) && owners.get(id) !== batch.shard_id) pairwiseOverlap++;
      owners.set(id, batch.shard_id);
      seen.add(id);
    }
  }
  return {
    missing_occurrences: Array.from(fullSet).filter(id => !seen.has(id)).length,
    unexpected_occurrences: Array.from(seen).filter(id => !fullSet.has(id)).length,
    duplicate_occurrences: duplicateOccurrences,
    accepted_pending_overlap: acceptedOverlap,
    pairwise_shard_overlap: pairwiseOverlap,
    duplicate_batches: duplicateBatches
  };
}

async function sourceSpecs(root: string) {
  const works = await loadLexicalAgentCorpus(root);
  const batchPlan = await loadLexicalAgentBatchPlan(root);
  if (batchPlan.version !== LEXICAL_AGENT_BATCH_PLAN_V2) throw new Error("Parallel plan requires frozen batch plan v2.");
  return buildLexicalAgentWorkBatchSpecs(works, "annotation", LEXICAL_AGENT_PROVENANCE, batchPlan);
}

export async function buildLexicalParallelPlan(root = process.cwd()) {
  const paths = lexicalAgentPaths(root);
  if (await exists(planPath(root))) throw new Error("Parallel plan already exists; immutable plan cannot be regenerated.");
  if (await exists(paths.activeLock)) throw new Error("Global annotation batch is active.");
  const manifestBytes = await readFile(paths.manifest);
  const manifest = JSON.parse(manifestBytes.toString()) as Record<string, any>;
  if (manifest.agent_batch_plan_version !== LEXICAL_AGENT_BATCH_PLAN_V2 || manifest.agent_progress?.active_batch_id !== null ||
      manifest.phase !== "agent_annotation_checkpointed") throw new Error("Global annotation frontier is not idle at batch plan v2.");
  const specs = await sourceSpecs(root);
  const acceptedCount = manifest.agent_progress.completed_batches;
  if (!Number.isInteger(acceptedCount) || acceptedCount !== manifest.agent_progress.next_batch_index ||
      specs.length !== manifest.planned_annotation_batches) throw new Error("Manifest annotation frontier does not match frozen batch plan.");
  const accepted = await acceptedSnapshot(root, specs, acceptedCount);
  const pendingSpecs = specs.slice(acceptedCount);
  const batchesWithFiles = pendingSpecs.map(spec => {
    const input = { ...annotationInput(spec), parallel_plan_version: LEXICAL_PARALLEL_PLAN_VERSION, shard_id: -1 };
    const count = expectedTokens(spec).length;
    const canonicalChars = spec.works!.reduce((total, work) => total + work.block.text.length, 0);
    const estimatedInput = Buffer.byteLength(json(input)) + Buffer.byteLength(json(spec.works));
    const estimatedOutput = count * 510 + canonicalChars * 2;
    return { spec, count, estimatedInput, estimatedOutput, weight: estimatedOutput + Math.ceil(estimatedInput / 4) };
  });
  const { batches, shards } = balanceParallelBatches(batchesWithFiles.map(({spec, count, estimatedInput, estimatedOutput, weight}) => ({
    batch_id: spec.batchId, batch_index: spec.index, source_type: spec.sourceType!, input_signature: spec.inputSignature,
    occurrence_count: count, estimated_input_bytes: estimatedInput, estimated_output_bytes: estimatedOutput,
    weight, input_sha256: "", work_sha256: ""
  })));
  const byId = new Map(batches.map(batch => [batch.batch_id, batch]));
  const coverage = checkParallelCoverage(accepted.ids, specs.flatMap(expectedTokens), batchesWithFiles.map(({spec}) => ({
    batch_id: spec.batchId, shard_id: byId.get(spec.batchId)!.shard_id, candidate_ids: expectedTokens(spec)
  })));
  if (Object.values(coverage).some(value => value !== 0)) throw new Error(`Parallel coverage failure: ${JSON.stringify(coverage)}`);
  await mkdir(parallelRoot(root), { recursive: true });
  for (const shard of shards) {
    for (const folder of ["inputs", "pending", "outputs", "checkpoints"]) {
      await mkdir(path.join(shardRoot(root, shard.shard_id), folder), { recursive: true });
    }
  }
  for (const {spec} of batchesWithFiles) {
    const batch = byId.get(spec.batchId)!;
    const input = { ...annotationInput(spec), parallel_plan_version: LEXICAL_PARALLEL_PLAN_VERSION, shard_id: batch.shard_id };
    const work = spec.works!;
    const inputBytes = json(input);
    const workBytes = json(work);
    batch.input_sha256 = hash(inputBytes);
    batch.work_sha256 = hash(workBytes);
    await Promise.all([
      writeFile(inputPath(root, batch.shard_id, batch.batch_id), inputBytes, { flag: "wx" }),
      writeFile(workPath(root, batch.shard_id, batch.batch_id), workBytes, { flag: "wx" })
    ]);
  }
  const [batchPlanBytes, blockBytes, tokenBytes] = await Promise.all([
    readFile(paths.batchPlan), readFile(paths.canonicalBlocks), readFile(paths.tokenCandidates)
  ]);
  const plan: ParallelPlan = {
    parallel_plan_version: LEXICAL_PARALLEL_PLAN_VERSION, batch_plan_version: LEXICAL_AGENT_BATCH_PLAN_V2,
    generation_version: LEXICAL_GENERATION_VERSION, provenance: LEXICAL_CURRENT_AGENT_PROVENANCE,
    ...LEXICAL_CURRENT_AGENT_PROVENANCE,
    created_from_manifest_sha256: hash(manifestBytes), batch_plan_sha256: hash(batchPlanBytes),
    canonical_blocks_sha256: hash(blockBytes), token_candidates_sha256: hash(tokenBytes),
    accepted_batch_ids_excluded: specs.slice(0, acceptedCount).map(spec => spec.batchId),
    accepted_checkpoint_sha256: accepted.checkpointHashes,
    accepted_input_sha256: accepted.inputHashes, accepted_output_sha256: accepted.outputHashes,
    shard_count: LEXICAL_PARALLEL_SHARD_COUNT, batches, shards,
    total_accepted_occurrences: accepted.ids.size,
    total_pending_occurrences: batches.reduce((sum, batch) => sum + batch.occurrence_count, 0),
    full_workload_occurrences: specs.reduce((sum, spec) => sum + expectedTokens(spec).length, 0)
  };
  const planBytes = json(plan);
  await writeFile(planPath(root), planBytes, { flag: "wx" });
  for (const shard of shards) {
    await writeFile(manifestPath(root, shard.shard_id), json(initialShardManifest(plan, hash(planBytes), shard)), { flag: "wx" });
  }
  manifest.phase = "agent_annotation_parallel_ready";
  manifest.parallel_plan_version = LEXICAL_PARALLEL_PLAN_VERSION;
  manifest.parallel_plan_sha256 = hash(planBytes);
  manifest.shard_count = LEXICAL_PARALLEL_SHARD_COUNT;
  manifest.complete = false;
  manifest.import_ready = false;
  manifest.updated_at = new Date().toISOString();
  await atomicJson(paths.manifest, manifest);
  return { plan, coverage };
}

function initialShardManifest(plan: ParallelPlan, digest: string, shard: Shard): ShardManifest {
  return {
    parallel_plan_version: plan.parallel_plan_version, plan_sha256: digest,
    shard_id: shard.shard_id, shard_count: plan.shard_count, batch_plan_version: plan.batch_plan_version,
    phase: shard.batch_count ? "pending" : "complete", complete: shard.batch_count === 0,
    assigned_batch_count: shard.batch_count, accepted_batch_count: 0, pending_batch_count: shard.batch_count,
    assigned_occurrence_count: shard.occurrence_count, accepted_occurrence_count: 0,
    next_batch: shard.assigned_batch_ids[0] ?? null, active_batch_id: null, last_checkpoint: null, errors: []
  };
}

async function loadPlan(root: string) {
  const bytes = await readFile(planPath(root));
  const plan = JSON.parse(bytes.toString()) as ParallelPlan;
  const digest = hash(bytes);
  const global = await readJson<Record<string, unknown>>(lexicalAgentPaths(root).manifest);
  if (plan.parallel_plan_version !== LEXICAL_PARALLEL_PLAN_VERSION || plan.batch_plan_version !== LEXICAL_AGENT_BATCH_PLAN_V2 ||
      plan.generation_version !== LEXICAL_GENERATION_VERSION || plan.shard_count !== LEXICAL_PARALLEL_SHARD_COUNT ||
      !lexicalSemanticProvenanceMatches(plan.provenance, LEXICAL_CURRENT_AGENT_PROVENANCE) ||
      global.parallel_plan_version !== plan.parallel_plan_version || global.parallel_plan_sha256 !== digest ||
      !["agent_annotation_parallel_ready", "agent_annotation_merged"].includes(String(global.phase)) ||
      hash(await readFile(lexicalAgentPaths(root).batchPlan)) !== plan.batch_plan_sha256) {
    throw new Error("Stale or modified parallel plan / coordinator manifest.");
  }
  return { plan, digest };
}

async function loadShard(root: string, id: number) {
  if (!Number.isInteger(id) || id < 0 || id >= LEXICAL_PARALLEL_SHARD_COUNT) throw new Error("Invalid shard id.");
  const { plan, digest } = await loadPlan(root);
  const shard = plan.shards[id];
  const manifest = await readJson<ShardManifest>(manifestPath(root, id));
  if (shard?.shard_id !== id || manifest.shard_id !== id || manifest.plan_sha256 !== digest ||
      manifest.parallel_plan_version !== plan.parallel_plan_version || manifest.batch_plan_version !== plan.batch_plan_version ||
      manifest.assigned_batch_count !== shard.batch_count || manifest.assigned_occurrence_count !== shard.occurrence_count ||
      manifest.accepted_batch_count < 0 || manifest.accepted_batch_count > shard.batch_count ||
      manifest.accepted_occurrence_count !== shard.assigned_batch_ids.slice(0, manifest.accepted_batch_count)
        .reduce((total, batchId) => total + plan.batches.find(batch => batch.batch_id === batchId)!.occurrence_count, 0) ||
      manifest.complete !== (manifest.accepted_batch_count === shard.batch_count) ||
      (manifest.complete && manifest.active_batch_id !== null) ||
      manifest.next_batch !== (shard.assigned_batch_ids[manifest.accepted_batch_count] ?? null) ||
      manifest.pending_batch_count !== shard.batch_count - manifest.accepted_batch_count) {
    throw new Error(`Shard ${id} manifest / immutable plan mismatch.`);
  }
  return { plan, shard, manifest };
}

function assertOwner(owner: string) {
  if (!/^[a-zA-Z0-9_-]{6,100}$/.test(owner)) throw new Error("Supply a unique OpenChamber session ID as --owner.");
}

export async function nextParallelAnnotationBatch(id: number, owner: string, root = process.cwd()) {
  assertOwner(owner);
  const {plan, shard, manifest} = await loadShard(root, id);
  const lock = lockPath(root, id);
  if (await exists(lock)) {
    const active = await readJson<Active>(lock);
    if (active.owner !== owner) throw new Error(`Shard ${id} already has another active writer.`);
    if (manifest.active_batch_id === null && manifest.last_checkpoint === active.batch_id &&
        await exists(checkpointPath(root, id, active.batch_id)) && await exists(acceptedOutput(root, id, active.batch_id))) {
      await unlink(lock); // Recover a crash after manifest flush but before lock removal.
      return nextParallelAnnotationBatch(id, owner, root);
    }
    if (active.batch_id !== manifest.next_batch || active.shard_id !== id) throw new Error("Active shard lock / frontier mismatch.");
    return active; // Same session resumes its pending batch without rewriting input or output.
  }
  if (manifest.active_batch_id) throw new Error(`Shard ${id} has an unfinished manifest batch without its lock.`);
  if (manifest.complete) return null;
  const batch = plan.batches.find(entry => entry.batch_id === manifest.next_batch);
  if (!batch || batch.shard_id !== id || !shard.assigned_batch_ids.includes(batch.batch_id)) throw new Error("Wrong shard assignment.");
  const input = inputPath(root, id, batch.batch_id);
  if (hash(await readFile(input)) !== batch.input_sha256) throw new Error("Immutable shard input changed.");
  const active: Active = {
    batch_id: batch.batch_id, shard_id: id, parallel_plan_version: plan.parallel_plan_version, owner,
    input_path: path.relative(root, input), output_path: path.relative(root, pendingOutput(root, id, batch.batch_id)),
    prepared_at: new Date().toISOString()
  };
  const handle = await open(lock, "wx");
  try {
    await handle.writeFile(json(active));
  } finally {
    await handle.close();
  }
  manifest.phase = "active";
  manifest.active_batch_id = batch.batch_id;
  await atomicJson(manifestPath(root, id), manifest);
  return active;
}

async function validateOutput(root: string, plan: ParallelPlan, batch: Batch, output: Record<string, unknown>) {
  const envelope = ["protocol_version", "stage", "batch_id", "generation_version", "provenance", "batch_plan_version",
    "parallel_plan_version", "shard_id", "input_signature", "blocks"];
  if (envelope.some(key => !(key in output)) || Object.keys(output).some(key => !envelope.includes(key) && key !== "schema_version") ||
      (output.schema_version !== undefined && output.schema_version !== LEXICAL_AGENT_ANNOTATION_SCHEMA_VERSION)) {
    throw new Error(`Invalid structured output envelope for ${batch.batch_id}.`);
  }
  if (output.protocol_version !== LEXICAL_AGENT_PROTOCOL_VERSION || output.stage !== "annotation" ||
      output.batch_id !== batch.batch_id || output.batch_plan_version !== plan.batch_plan_version ||
      output.parallel_plan_version !== plan.parallel_plan_version || output.shard_id !== batch.shard_id ||
      output.generation_version !== plan.generation_version || output.input_signature !== batch.input_signature ||
      !lexicalSemanticProvenanceMatches(output.provenance, plan.provenance) ||
      Object.keys(output.provenance as Record<string, unknown>).length !== Object.keys(plan.provenance).length ||
      output.recovered_by_lexeme !== undefined) throw new Error(`Wrong-shard output / envelope / provenance for ${batch.batch_id}.`);
  if (hash(await readFile(inputPath(root, batch.shard_id, batch.batch_id))) !== batch.input_sha256 ||
      hash(await readFile(workPath(root, batch.shard_id, batch.batch_id))) !== batch.work_sha256) {
    throw new Error(`Stale input or validation work for ${batch.batch_id}.`);
  }
  const works = await readJson<LexicalBlockWork[]>(workPath(root, batch.shard_id, batch.batch_id));
  if (!Array.isArray(output.blocks)) throw new Error("Missing annotation blocks.");
  for (const block of output.blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block) ||
        Object.keys(block).some(key => !["block_key", "tokens"].includes(key)) || !Array.isArray(block.tokens)) {
      throw new Error("Invalid structured annotation block.");
    }
    for (const token of block.tokens) {
      const fields = ["candidate_id", "context_pos", "context_meaning_zh", "context_definition_en",
        "canonical_expression", "lemma", "expression_type", "needs_review", "review_notes"];
      if (!token || typeof token !== "object" || Array.isArray(token) ||
          Object.keys(token).length !== fields.length || fields.some(field => !(field in token))) {
        throw new Error("Invalid structured token annotation.");
      }
    }
  }
  const occurrences = validateAnnotationBatch(works, {
    blocks: (output.blocks as Record<string, unknown>[]).map(block => ({...block, expressions: []}))
  });
  if (occurrences.length !== batch.occurrence_count || new Set(occurrences.map(occurrenceKey)).size !== batch.occurrence_count ||
      occurrences.some(o => o.context_text.slice(o.start_offset, o.end_offset) !== o.surface_text || o.layer !== 1)) {
    throw new Error(`Missing or duplicate occurrence in ${batch.batch_id}.`);
  }
  return occurrences;
}

export async function acceptParallelAnnotationBatch(id: number, batchId: string, owner: string, root = process.cwd()) {
  assertOwner(owner);
  const {plan, shard, manifest} = await loadShard(root, id);
  const active = await readJson<Active>(lockPath(root, id));
  if (active.shard_id !== id || active.owner !== owner || active.parallel_plan_version !== plan.parallel_plan_version ||
      active.batch_id !== batchId || manifest.active_batch_id !== batchId || manifest.next_batch !== batchId) {
    throw new Error("Wrong shard, owner, batch, or active frontier.");
  }
  const batch = plan.batches.find(value => value.batch_id === batchId);
  if (!batch || batch.shard_id !== id || !shard.assigned_batch_ids.includes(batchId)) throw new Error("Wrong-shard accept rejected.");
  const pending = pendingOutput(root, id, batchId);
  const accepted = acceptedOutput(root, id, batchId);
  const outputFile = await exists(pending) ? pending : accepted; // Recovery after a mid-accept interruption.
  const output = await readJson<Record<string, unknown>>(outputFile);
  const occurrences = await validateOutput(root, plan, batch, output);
  const checkpoint = { protocol_version: LEXICAL_AGENT_PROTOCOL_VERSION, batch_id: batchId, shard_id: id,
    parallel_plan_version: plan.parallel_plan_version, batch_plan_version: plan.batch_plan_version,
    generation_version: plan.generation_version, input_signature: batch.input_signature,
    provenance: plan.provenance, occurrences };
  const checkpointFile = checkpointPath(root, id, batchId);
  if (await exists(checkpointFile)) {
    const previous = await readJson<typeof checkpoint>(checkpointFile);
    if (JSON.stringify(previous) !== JSON.stringify(checkpoint)) throw new Error("Immutable shard checkpoint changed.");
  } else {
    await writeFile(checkpointFile, json(checkpoint), {flag: "wx"});
  }
  if (await exists(accepted)) {
    if (hash(await readFile(accepted)) !== hash(await readFile(outputFile))) throw new Error("Immutable accepted shard output changed.");
    if (await exists(pending)) await unlink(pending);
  } else {
    await rename(pending, accepted);
  }
  const progress = manifest.accepted_batch_count + 1;
  manifest.accepted_batch_count = progress;
  manifest.pending_batch_count = shard.batch_count - progress;
  manifest.accepted_occurrence_count += occurrences.length;
  manifest.last_checkpoint = batchId;
  manifest.next_batch = shard.assigned_batch_ids[progress] ?? null;
  manifest.active_batch_id = null;
  manifest.complete = progress === shard.batch_count;
  manifest.phase = manifest.complete ? "complete" : "pending";
  await atomicJson(manifestPath(root, id), manifest);
  await unlink(lockPath(root, id));
  return {accepted: batchId, shard_id: id, occurrences: occurrences.length};
}

export async function abortParallelAnnotationBatch(id: number, owner: string, reason: string, root = process.cwd()) {
  assertOwner(owner);
  if (!reason.trim()) throw new Error("A concrete blocker reason is required.");
  const {manifest} = await loadShard(root, id);
  const active = await readJson<Active>(lockPath(root, id));
  if (active.owner !== owner || active.shard_id !== id || active.batch_id !== manifest.active_batch_id ||
      manifest.next_batch !== active.batch_id) throw new Error("Wrong owner or active shard batch.");
  manifest.errors.push(`${active.batch_id}: ${reason.trim()}`);
  manifest.phase = "pending";
  manifest.active_batch_id = null;
  await atomicJson(manifestPath(root, id), manifest);
  await unlink(lockPath(root, id));
  return {shard_id: id, pending_batch_id: active.batch_id, last_checkpoint: manifest.last_checkpoint};
}

export async function parallelAnnotationStatus(root = process.cwd()) {
  const {plan} = await loadPlan(root);
  const shards = await Promise.all(plan.shards.map(async shard => {
    const state = await loadShard(root, shard.shard_id);
    return {shard_id: shard.shard_id, accepted_batches: state.manifest.accepted_batch_count,
      assigned_batches: shard.batch_count, accepted_occurrences: state.manifest.accepted_occurrence_count,
      assigned_occurrences: shard.occurrence_count, active: await exists(lockPath(root, shard.shard_id)),
      next_batch: state.manifest.next_batch, last_checkpoint: state.manifest.last_checkpoint};
  }));
  return { shards, finished_shards: shards.filter(shard => shard.accepted_batches === shard.assigned_batches && !shard.active).length,
    remaining_batches: shards.reduce((sum, shard) => sum + shard.assigned_batches - shard.accepted_batches, 0),
    remaining_occurrences: shards.reduce((sum, shard) => sum + shard.assigned_occurrences - shard.accepted_occurrences, 0) };
}

export async function auditParallelAnnotationPlan(root = process.cwd()) {
  const {plan} = await loadPlan(root);
  const paths = lexicalAgentPaths(root);
  const [blocks, tokens, specs] = await Promise.all([
    readFile(paths.canonicalBlocks), readFile(paths.tokenCandidates), sourceSpecs(root)
  ]);
  if (hash(blocks) !== plan.canonical_blocks_sha256 || hash(tokens) !== plan.token_candidates_sha256) {
    throw new Error("Stale parallel plan: canonical corpus changed.");
  }
  const acceptedIds = plan.accepted_batch_ids_excluded;
  const accepted = await acceptedSnapshot(root, specs, acceptedIds.length);
  if (acceptedIds.some((id, index) => specs[index]?.batchId !== id ||
      accepted.checkpointHashes[id] !== plan.accepted_checkpoint_sha256[id] ||
      accepted.inputHashes[id] !== plan.accepted_input_sha256[id] ||
      accepted.outputHashes[id] !== plan.accepted_output_sha256[id])) {
    throw new Error("Accepted annotation set changed since plan creation.");
  }
  const assigned = plan.shards.flatMap(shard => shard.assigned_batch_ids);
  const planned = new Set(plan.batches.map(batch => batch.batch_id));
  const missingBatches = plan.batches.filter(batch => !assigned.includes(batch.batch_id)).length;
  const duplicateBatches = assigned.length - new Set(assigned).size;
  if (plan.batches.length !== specs.length - acceptedIds.length || assigned.length !== plan.batches.length ||
      assigned.some(id => !planned.has(id))) throw new Error("Plan batch assignment count mismatch.");
  const pending = [];
  for (let index = 0; index < plan.batches.length; index++) {
    const batch = plan.batches[index];
    const spec = specs[index + acceptedIds.length];
    if (batch.batch_id !== spec.batchId || batch.input_signature !== spec.inputSignature ||
        batch.shard_id < 0 || batch.shard_id >= 8) throw new Error(`Stale batch assignment ${batch.batch_id}.`);
    const inputBytes = await readFile(inputPath(root, batch.shard_id, batch.batch_id));
    const workBytes = await readFile(workPath(root, batch.shard_id, batch.batch_id));
    if (hash(inputBytes) !== batch.input_sha256 || hash(workBytes) !== batch.work_sha256) {
      throw new Error(`Immutable shard input changed: ${batch.batch_id}.`);
    }
    const input = JSON.parse(inputBytes.toString()) as {batch_id: string; shard_id: number; input_signature: string;
      blocks: Array<{eligible_tokens: Array<{candidate_id: string}>}>};
    if (input.batch_id !== batch.batch_id || input.shard_id !== batch.shard_id ||
        input.input_signature !== batch.input_signature ||
        plan.shards[batch.shard_id].assigned_batch_ids.filter(id => id === batch.batch_id).length !== 1) {
      throw new Error(`Wrong shard input ${batch.batch_id}.`);
    }
    pending.push({batch_id: batch.batch_id, shard_id: batch.shard_id,
      candidate_ids: input.blocks.flatMap(block => block.eligible_tokens.map(token => token.candidate_id))});
  }
  const coverage = checkParallelCoverage(accepted.ids, specs.flatMap(expectedTokens), pending);
  if (plan.total_accepted_occurrences !== accepted.ids.size ||
      plan.total_pending_occurrences !== pending.reduce((count, batch) => count + batch.candidate_ids.length, 0) ||
      plan.full_workload_occurrences !== specs.reduce((count, spec) => count + expectedTokens(spec).length, 0) ||
      missingBatches || duplicateBatches || Object.values(coverage).some(count => count !== 0)) {
    throw new Error(`Parallel plan coverage failure: ${JSON.stringify(coverage)}`);
  }
  return {accepted_batches: acceptedIds.length, accepted_occurrences: accepted.ids.size,
    pending_batches: plan.batches.length, pending_occurrences: plan.total_pending_occurrences,
    full_occurrences: plan.full_workload_occurrences, missing_batches: missingBatches,
    ...coverage, duplicate_batches: duplicateBatches};
}

export async function verifyParallelAnnotation(root = process.cwd()) {
  const {plan} = await loadPlan(root);
  const paths = lexicalAgentPaths(root);
  const [blocks, tokens] = await Promise.all([readFile(paths.canonicalBlocks), readFile(paths.tokenCandidates)]);
  if (hash(blocks) !== plan.canonical_blocks_sha256 || hash(tokens) !== plan.token_candidates_sha256) throw new Error("Stale parallel plan: canonical corpus changed.");
  const specs = await sourceSpecs(root);
  const acceptedIds = plan.accepted_batch_ids_excluded;
  if (new Set(acceptedIds).size !== acceptedIds.length || acceptedIds.some((id, index) => specs[index]?.batchId !== id) ||
      plan.batches.length !== specs.length - acceptedIds.length ||
      plan.batches.some((batch, index) => specs[index + acceptedIds.length]?.batchId !== batch.batch_id ||
        specs[index + acceptedIds.length]?.inputSignature !== batch.input_signature)) throw new Error("Stale parallel plan: batch identity changed.");
  const snapshot = await acceptedSnapshot(root, specs, acceptedIds.length);
  for (const id of acceptedIds) {
    if (snapshot.checkpointHashes[id] !== plan.accepted_checkpoint_sha256[id] ||
        snapshot.inputHashes[id] !== plan.accepted_input_sha256[id] || snapshot.outputHashes[id] !== plan.accepted_output_sha256[id]) {
      throw new Error(`Immutable accepted set changed: ${id}.`);
    }
  }
  const status = await parallelAnnotationStatus(root);
  if (status.finished_shards !== 8 || status.remaining_batches || status.remaining_occurrences || status.shards.some(shard => shard.active)) {
    throw new Error("Parallel annotation incomplete or active shard lock present.");
  }
  for (const shard of plan.shards) {
    const folder = shardRoot(root, shard.shard_id);
    const expected = shard.assigned_batch_ids;
    const [outputs, checkpoints, pending] = await Promise.all([
      readdir(path.join(folder, "outputs")), readdir(path.join(folder, "checkpoints")), readdir(path.join(folder, "pending"))
    ]);
    if (pending.length || outputs.length !== expected.length || checkpoints.length !== expected.length ||
        outputs.some(file => !expected.includes(file.replace(/\.output\.json$/, "")) || !file.endsWith(".output.json")) ||
        checkpoints.some(file => !expected.includes(file.replace(/\.json$/, "")) || !file.endsWith(".json"))) {
      throw new Error(`Shard ${shard.shard_id} has missing, duplicate, or wrong-shard output files.`);
    }
  }
  const pending: Array<{ batch_id: string; shard_id: number; candidate_ids: string[] }> = [];
  let wrongShardOutputs = 0;
  let invalidProvenance = 0;
  let invalidSignatures = 0;
  for (const batch of plan.batches) {
    if (plan.shards[batch.shard_id]?.assigned_batch_ids.filter(id => id === batch.batch_id).length !== 1) throw new Error("Missing or duplicate batch assignment.");
    const input = await readJson<{blocks: Array<{eligible_tokens: Array<{candidate_id: string}>}>}>(inputPath(root, batch.shard_id, batch.batch_id));
    pending.push({batch_id: batch.batch_id, shard_id: batch.shard_id, candidate_ids: input.blocks.flatMap(block => block.eligible_tokens.map(t => t.candidate_id))});
    if (await exists(pendingOutput(root, batch.shard_id, batch.batch_id))) throw new Error("Unfinished pending output remains.");
    const output = await readJson<Record<string, unknown>>(acceptedOutput(root, batch.shard_id, batch.batch_id));
    if (output.shard_id !== batch.shard_id) wrongShardOutputs++;
    if (!lexicalSemanticProvenanceMatches(output.provenance, plan.provenance)) invalidProvenance++;
    if (output.input_signature !== batch.input_signature) invalidSignatures++;
    const occurrences = await validateOutput(root, plan, batch, output);
    const checkpoint = await readJson<Record<string, unknown>>(checkpointPath(root, batch.shard_id, batch.batch_id));
    if (checkpoint.batch_id !== batch.batch_id || checkpoint.shard_id !== batch.shard_id ||
        checkpoint.parallel_plan_version !== plan.parallel_plan_version || checkpoint.input_signature !== batch.input_signature ||
        !lexicalSemanticProvenanceMatches(checkpoint.provenance, plan.provenance) ||
        JSON.stringify(checkpoint.occurrences) !== JSON.stringify(occurrences)) throw new Error(`Invalid shard checkpoint ${batch.batch_id}.`);
  }
  const coverage = checkParallelCoverage(snapshot.ids, specs.flatMap(expectedTokens), pending);
  const assigned = plan.shards.flatMap(shard => shard.assigned_batch_ids);
  const missingBatches = plan.batches.filter(batch => !assigned.includes(batch.batch_id)).length;
  const duplicateBatches = assigned.length - new Set(assigned).size + coverage.duplicate_batches;
  if (plan.total_accepted_occurrences !== snapshot.ids.size || plan.total_pending_occurrences !== pending.reduce((sum, b) => sum + b.candidate_ids.length, 0) ||
      plan.full_workload_occurrences !== specs.reduce((sum, s) => sum + expectedTokens(s).length, 0) ||
      missingBatches || duplicateBatches || wrongShardOutputs || invalidProvenance || invalidSignatures || Object.values(coverage).some(value => value !== 0)) {
    throw new Error("Parallel annotation verification failed.");
  }
  return {shards_complete: 8, active_locks: 0, missing_batches: missingBatches,
    ...coverage, duplicate_batches: duplicateBatches,
    wrong_shard_outputs: wrongShardOutputs, invalid_provenance: invalidProvenance, invalid_signatures: invalidSignatures};
}

export async function mergeParallelAnnotation(root = process.cwd()) {
  const result = await verifyParallelAnnotation(root);
  const {plan} = await loadPlan(root);
  const paths = lexicalAgentPaths(root);
  const ordered = [...plan.batches].sort((a, b) => a.batch_index - b.batch_index);
  for (const batch of ordered) {
    const id = batch.batch_id;
    for (const [from, to] of [
      [checkpointPath(root, batch.shard_id, id), path.join(paths.checkpointRoot, "annotation", `${id}.json`)],
      [inputPath(root, batch.shard_id, id), path.join(paths.acceptedDir, "annotation", `${id}.input.json`)],
      [acceptedOutput(root, batch.shard_id, id), path.join(paths.acceptedDir, "annotation", `${id}.output.json`)]
    ]) {
      if (await exists(to)) {
        if (hash(await readFile(from)) !== hash(await readFile(to))) throw new Error(`Merge cannot overwrite accepted artifact ${to}.`);
      } else {
        await mkdir(path.dirname(to), {recursive: true});
        await copyFile(from, to, constants.COPYFILE_EXCL);
      }
    }
  }
  const global = await readJson<Record<string, any>>(paths.manifest);
  global.phase = "agent_annotation_merged";
  global.generation.annotation_batches_completed = ordered.length + plan.accepted_batch_ids_excluded.length;
  global.agent_progress = {stage: "annotation", active_batch_id: null, completed_batches: global.generation.annotation_batches_completed,
    pending_batches: 0, next_batch_index: null, source_type: null};
  global.current_batch_index = null;
  global.current_source_type = null;
  global.updated_at = new Date().toISOString();
  await atomicJson(paths.manifest, global);
  return result;
}
