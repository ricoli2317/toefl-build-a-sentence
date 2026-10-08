import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  fileExists,
  readJson,
  readRequiredJson,
  sha256,
  sha256File,
  writeAtomic,
  writeJsonAtomic
} from "./artifacts.ts";
import { LEXICAL_GENERATION_VERSION } from "../generationTypes.ts";
import { incrementalAgentProvenance, type IncrementalAgentProvenance } from "./envelope.ts";
import { incrementalFile, stagePaths, type IncrementalStage } from "./paths.ts";

export const INCREMENTAL_STAGE_PLAN_VERSION = "lexical-incremental-agent-plan-v1";

export type IncrementalStagePlanBatch = {
  batch_id: string;
  batch_index: number;
  source_type: string;
  input_signature: string;
  input_sha256: string;
  work_sha256: string;
  block_keys: string[];
};

export type IncrementalStagePlan = {
  stage: IncrementalStage;
  version: typeof INCREMENTAL_STAGE_PLAN_VERSION;
  generation_version: typeof LEXICAL_GENERATION_VERSION;
  provenance: IncrementalAgentProvenance;
  created_at: string;
  source_plan_sha256: string | null;
  batches: IncrementalStagePlanBatch[];
};

export type IncrementalStageState = {
  stage: IncrementalStage;
  plan_sha256: string;
  errors: string[];
};

export type IncrementalClaim = {
  batch_id: string;
  owner: string;
  prepared_at: string;
};

export function incrementalBatchId(stage: IncrementalStage, batchIndex: number, inputSignature: string) {
  return `${stage.replace("-", "")}-${sha256(`${stage}:${batchIndex}:${inputSignature}`).slice(0, 20)}`;
}

export function assertIncrementalOwner(owner: string) {
  if (!/^[a-zA-Z0-9_-]{6,100}$/.test(owner)) throw new Error("Supply --owner OWNER (6-100 url-safe characters).");
}

const claimsDir = (paths: ReturnType<typeof stagePaths>) => path.join(paths.stageRoot, "claims");
const claimPath = (paths: ReturnType<typeof stagePaths>, batchId: string) => path.join(claimsDir(paths), `${batchId}.claim.json`);
const abortsDir = (paths: ReturnType<typeof stagePaths>) => path.join(paths.stageRoot, "aborts");
const receiptPath = (paths: ReturnType<typeof stagePaths>, batchId: string) => path.join(paths.stageRoot, "receipts", `${batchId}.json`);
type AcceptanceReceipt = { plan_sha256: string; output_sha256: string; checkpoint_sha256: string };

async function safeReaddir(folder: string) {
  try {
    return await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export type StageBatchInput = {
  sourceType: string;
  inputSignature: string;
  blockKeys: string[];
  input: unknown;
  work: unknown;
};

export async function initStage(root: string, stage: IncrementalStage, options: {
  sourcePlanSha256: string | null;
  provenance?: IncrementalAgentProvenance;
  batches: StageBatchInput[];
}) {
  const paths = stagePaths(root, stage);
  if (await fileExists(paths.plan) || await fileExists(paths.state)) {
    throw new Error(`Incremental ${stage} plan already exists; it is immutable. Remove the workspace only for an explicitly aborted delta.`);
  }
  await Promise.all([paths.pending, paths.outputs, paths.checkpoints].map(folder => mkdir(folder, { recursive: true })));
  const plan: IncrementalStagePlan = {
    stage,
    version: INCREMENTAL_STAGE_PLAN_VERSION,
    generation_version: LEXICAL_GENERATION_VERSION,
    provenance: options.provenance ?? incrementalAgentProvenance(),
    created_at: new Date().toISOString(),
    source_plan_sha256: options.sourcePlanSha256,
    batches: []
  };
  for (let index = 0; index < options.batches.length; index += 1) {
    const batch = options.batches[index];
    const batchId = incrementalBatchId(stage, index, batch.inputSignature);
    const inputBytes = `${JSON.stringify(batch.input, null, 2)}\n`;
    const workBytes = `${JSON.stringify(batch.work, null, 2)}\n`;
    plan.batches.push({
      batch_id: batchId,
      batch_index: index,
      source_type: batch.sourceType,
      input_signature: batch.inputSignature,
      input_sha256: sha256(inputBytes),
      work_sha256: sha256(workBytes),
      block_keys: batch.blockKeys
    });
    await writeAtomic(paths.inputPath(batchId), inputBytes);
    await writeAtomic(paths.workPath(batchId), workBytes);
  }
  const planBytes = `${JSON.stringify(plan, null, 2)}\n`;
  await writeAtomic(paths.plan, planBytes);
  const state: IncrementalStageState = {
    stage,
    plan_sha256: sha256(planBytes),
    errors: []
  };
  await writeJsonAtomic(paths.state, state);
  return plan;
}

export async function loadStage(root: string, stage: IncrementalStage) {
  const paths = stagePaths(root, stage);
  const plan = await readRequiredJson<IncrementalStagePlan>(paths.plan);
  const state = await readRequiredJson<IncrementalStageState>(paths.state);
  if (plan.version !== INCREMENTAL_STAGE_PLAN_VERSION || plan.stage !== stage || state.stage !== stage) {
    throw new Error(`Incremental ${stage} plan/state identity mismatch.`);
  }
  if (await sha256File(paths.plan) !== state.plan_sha256) {
    throw new Error(`Incremental ${stage} plan changed after state creation.`);
  }
  if (plan.source_plan_sha256 && await sha256File(incrementalFile(root, "delta-plan.json")) !== plan.source_plan_sha256) {
    throw new Error(`Incremental ${stage} source delta plan changed after stage creation.`);
  }
  for (const batch of plan.batches) {
    if (await sha256File(paths.inputPath(batch.batch_id)) !== batch.input_sha256
      || await sha256File(paths.workPath(batch.batch_id)) !== batch.work_sha256) {
      throw new Error(`Immutable ${stage} batch input/work changed: ${batch.batch_id}.`);
    }
  }
  // Accepted is derived from durable checkpoints; claims are per-batch exclusive files.
  const accepted = new Set<string>();
  for (const batch of plan.batches) {
    const receipt = await readJson<AcceptanceReceipt>(receiptPath(paths, batch.batch_id));
    if (receipt) {
      if (receipt.plan_sha256 !== state.plan_sha256
        || await sha256File(paths.outputPath(batch.batch_id)) !== receipt.output_sha256
        || await sha256File(paths.checkpointPath(batch.batch_id)) !== receipt.checkpoint_sha256) {
        throw new Error(`Accepted ${stage} output/checkpoint changed: ${batch.batch_id}.`);
      }
      accepted.add(batch.batch_id);
    } else if (await fileExists(paths.checkpointPath(batch.batch_id)) && await fileExists(paths.outputPath(batch.batch_id))) {
      // First-run compatibility only. Completeness requires revalidation and a durable receipt.
      accepted.add(batch.batch_id);
    }
  }
  return { plan, state, paths, accepted };
}

async function currentClaims(paths: ReturnType<typeof stagePaths>) {
  const claims = new Map<string, IncrementalClaim>();
  for (const entry of await safeReaddir(claimsDir(paths))) {
    if (!entry.endsWith(".claim.json")) continue;
    const claim = await readJson<IncrementalClaim>(path.join(claimsDir(paths), entry));
    if (claim) claims.set(claim.batch_id, claim);
  }
  return claims;
}

export async function nextStageBatch(root: string, stage: IncrementalStage, owner: string) {
  assertIncrementalOwner(owner);
  const { plan, paths, accepted } = await loadStage(root, stage);
  const claims = await currentClaims(paths);
  const mine = Array.from(claims.values()).find((claim) => claim.owner === owner && !accepted.has(claim.batch_id));
  const summary = () => ({
    accepted_batches: accepted.size,
    total_batches: plan.batches.length,
    other_active_writers: Array.from(claims.values())
      .filter((claim) => claim.owner !== owner && !accepted.has(claim.batch_id))
      .map((claim) => claim.owner)
  });
  if (mine) {
    return {
      done: false as const,
      batch_id: mine.batch_id,
      input_path: paths.inputPath(mine.batch_id),
      work_path: paths.workPath(mine.batch_id),
      output_path: paths.pendingPath(mine.batch_id),
      ...summary()
    };
  }
  if (accepted.size === plan.batches.length) return { done: true as const, ...summary() };
  for (const batch of plan.batches) {
    if (accepted.has(batch.batch_id) || claims.has(batch.batch_id)) continue;
    const claim: IncrementalClaim = { batch_id: batch.batch_id, owner, prepared_at: new Date().toISOString() };
    await mkdir(claimsDir(paths), { recursive: true });
    try {
      await writeFile(claimPath(paths, batch.batch_id), `${JSON.stringify(claim, null, 2)}\n`, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    // Another worker may have completed this batch after our accepted/claims snapshot.
    // Never return that accepted batch for regeneration; release only our own new claim.
    if (await fileExists(paths.checkpointPath(batch.batch_id)) && await fileExists(paths.outputPath(batch.batch_id))) {
      accepted.add(batch.batch_id);
      await unlink(claimPath(paths, batch.batch_id));
      continue;
    }
    return {
      done: false as const,
      batch_id: batch.batch_id,
      input_path: paths.inputPath(batch.batch_id),
      work_path: paths.workPath(batch.batch_id),
      output_path: paths.pendingPath(batch.batch_id),
      ...summary()
    };
  }
  if (accepted.size === plan.batches.length) return { done: true as const, ...summary() };
  // Every remaining batch is claimed by someone else right now.
  return { done: true as const, waiting_on_other_writers: true, ...summary() };
}

export async function acceptStageBatch(
  root: string,
  stage: IncrementalStage,
  batchId: string,
  owner: string,
  validate: (output: unknown, batch: IncrementalStagePlanBatch) => Promise<unknown>
) {
  assertIncrementalOwner(owner);
  const { plan, paths, accepted } = await loadStage(root, stage);
  const batch = plan.batches.find((value) => value.batch_id === batchId);
  if (!batch) throw new Error(`Unknown incremental ${stage} batch ${batchId}.`);
  if (accepted.has(batchId)) throw new Error(`Incremental ${stage} batch ${batchId} was already accepted.`);
  const claim = await readJson<IncrementalClaim>(claimPath(paths, batchId));
  if (!claim || claim.owner !== owner || claim.batch_id !== batchId) {
    throw new Error(`Incremental ${stage} accept does not match the active claim/owner for ${batchId}.`);
  }
  const pending = paths.pendingPath(batchId);
  const outputFile = paths.outputPath(batchId);
  const hasPending = await fileExists(pending);
  if (!hasPending) throw new Error(`Missing ${stage} pending output for ${batchId}.`);
  const outputBytes = await readFile(pending, "utf8");
  const output: unknown = JSON.parse(outputBytes);
  const checkpoint = await validate(output, batch);
  const checkpointBytes = `${JSON.stringify(checkpoint, null, 2)}\n`;
  const checkpointFile = paths.checkpointPath(batchId);
  // Output first, checkpoint second, hash-bound receipt last. Crash recovery revalidates pending.
  if (await fileExists(outputFile)) {
    if (await sha256File(outputFile) !== sha256(outputBytes)) throw new Error(`Immutable ${stage} output changed: ${batchId}.`);
  } else {
    await writeAtomic(outputFile, outputBytes);
  }
  if (await fileExists(checkpointFile)) {
    if (await sha256File(checkpointFile) !== sha256(checkpointBytes)) {
      throw new Error(`Immutable ${stage} checkpoint changed: ${batchId}.`);
    }
  } else {
    await writeAtomic(checkpointFile, checkpointBytes);
  }
  const { state } = await loadStage(root, stage);
  await writeJsonAtomic(receiptPath(paths, batchId), { plan_sha256: state.plan_sha256,
    output_sha256: sha256(outputBytes), checkpoint_sha256: sha256(checkpointBytes) });
  await unlink(pending).catch(() => undefined);
  await unlink(claimPath(paths, batchId)).catch(() => undefined);
  return { accepted: batchId, stage, accepted_batches: accepted.size + 1, total_batches: plan.batches.length };
}

export async function abortStageBatch(root: string, stage: IncrementalStage, owner: string, reason: string) {
  assertIncrementalOwner(owner);
  if (!reason.trim()) throw new Error("A concrete abort reason is required.");
  const { plan, paths } = await loadStage(root, stage);
  const claims = await currentClaims(paths);
  const mine = Array.from(claims.values()).find((claim) => claim.owner === owner);
  if (!mine) throw new Error(`Incremental ${stage} abort does not match an active claim for owner ${owner}.`);
  await mkdir(abortsDir(paths), { recursive: true });
  const record = {
    batch_id: mine.batch_id,
    owner,
    reason: reason.trim(),
    aborted_at: new Date().toISOString(),
    remaining_batches: plan.batches.length
  };
  await writeFile(path.join(abortsDir(paths), `${mine.batch_id}.abort.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" })
    .catch(() => undefined);
  await unlink(claimPath(paths, mine.batch_id)).catch(() => undefined);
  return { aborted: true as const, stage, batch_id: mine.batch_id };
}

export async function stageStatus(root: string, stage: IncrementalStage) {
  const { plan, state, paths, accepted } = await loadStage(root, stage);
  const claims = await currentClaims(paths);
  const aborts = [];
  for (const entry of await safeReaddir(abortsDir(paths))) {
    const record = await readJson(path.join(abortsDir(paths), entry));
    if (record) aborts.push(record);
  }
  const pendingFiles = (await safeReaddir(paths.pending)).filter((file) => file.endsWith(".output.json"));
  const knownIds = new Set(plan.batches.map(batch => batch.batch_id));
  const pendingOutputs = pendingFiles.filter(file => knownIds.has(file.replace(/\.output\.json$/, "")));
  return {
    stage,
    plan_sha256: state.plan_sha256,
    batches: plan.batches.length,
    accepted: accepted.size,
    pending_outputs: pendingOutputs.length,
    orphan_pending_outputs: pendingFiles.filter(file => !knownIds.has(file.replace(/\.output\.json$/, ""))),
    claims: Array.from(claims.values()).filter(claim => !accepted.has(claim.batch_id)),
    aborts,
    complete: accepted.size === plan.batches.length
  };
}

export async function readStageCheckpoint<T = unknown>(root: string, stage: IncrementalStage, batchId: string) {
  return await readJson<T>(stagePaths(root, stage).checkpointPath(batchId));
}

export async function readStageWork<T = unknown>(root: string, stage: IncrementalStage, batchId: string) {
  return await readRequiredJson<T>(stagePaths(root, stage).workPath(batchId));
}

export async function readStageInput<T = unknown>(root: string, stage: IncrementalStage, batchId: string) {
  return await readRequiredJson<T>(stagePaths(root, stage).inputPath(batchId));
}

export async function assertStageComplete(root: string, stage: IncrementalStage) {
  const status = await stageStatus(root, stage);
  if (!status.complete) {
    throw new Error(`Incremental ${stage} stage is not complete (accepted ${status.accepted}/${status.batches}).`);
  }
  const { plan, paths } = await loadStage(root, stage);
  for (const batch of plan.batches) {
    if (!await fileExists(receiptPath(paths, batch.batch_id))) throw new Error(`Accepted ${stage} checkpoint requires revalidation: ${batch.batch_id}.`);
  }
  return status;
}

/** Backfill receipts only after replaying the unchanged validators, never trusting file presence. */
export async function verifyStageCheckpoints(root: string, stage: IncrementalStage,
  validate: (output: unknown, batch: IncrementalStagePlanBatch) => Promise<unknown>) {
  const { plan, paths, state, accepted } = await loadStage(root, stage);
  for (const batch of plan.batches) {
    if (!accepted.has(batch.batch_id)) continue;
    const outputBytes = await readFile(paths.outputPath(batch.batch_id), "utf8");
    const checkpointBytes = await readFile(paths.checkpointPath(batch.batch_id), "utf8");
    const validated = await validate(JSON.parse(outputBytes), batch);
    if (JSON.stringify(validated) !== JSON.stringify(JSON.parse(checkpointBytes))) throw new Error(`Revalidation changed ${stage} checkpoint ${batch.batch_id}.`);
    await writeJsonAtomic(receiptPath(paths, batch.batch_id), { plan_sha256: state.plan_sha256,
      output_sha256: sha256(outputBytes), checkpoint_sha256: sha256(checkpointBytes) });
  }
  return { stage, verified: accepted.size, total: plan.batches.length };
}
