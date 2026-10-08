import path from "node:path";

/**
 * Permanent incremental lexical sync workspace. Everything here is local-only and
 * ignored by Git; the frozen full-generation corpus under tmp/lexical-v1 is never reused
 * as new delta output.
 */
export const INCREMENTAL_OUTPUT_ROOT = "tmp/lexical-incremental";

export const INCREMENTAL_STAGES = ["annotation", "mwe", "mwe-qa"] as const;
export type IncrementalStage = typeof INCREMENTAL_STAGES[number];

export function incrementalRoot(root = process.cwd()) {
  const run = process.env.LEXICAL_INCREMENTAL_RUN?.trim();
  if (run && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(run)) throw new Error("LEXICAL_INCREMENTAL_RUN must be a safe run name (1-100 characters).");
  return run ? path.join(root, INCREMENTAL_OUTPUT_ROOT, "runs", run) : path.join(root, INCREMENTAL_OUTPUT_ROOT);
}

export function incrementalFile(root: string, ...parts: string[]) {
  return path.join(incrementalRoot(root), ...parts);
}

export type IncrementalStagePaths = {
  stageRoot: string;
  plan: string;
  state: string;
  inputs: string;
  work: string;
  pending: string;
  outputs: string;
  checkpoints: string;
  inputPath: (batchId: string) => string;
  workPath: (batchId: string) => string;
  pendingPath: (batchId: string) => string;
  outputPath: (batchId: string) => string;
  checkpointPath: (batchId: string) => string;
};

export function stagePaths(root: string, stage: IncrementalStage): IncrementalStagePaths {
  const stageRoot = incrementalFile(root, "agent", stage);
  const inputs = path.join(stageRoot, "inputs");
  const work = path.join(stageRoot, "work");
  const pending = path.join(stageRoot, "pending");
  const outputs = path.join(stageRoot, "outputs");
  const checkpoints = path.join(stageRoot, "checkpoints");
  return {
    stageRoot,
    plan: path.join(stageRoot, "plan.json"),
    state: path.join(stageRoot, "state.json"),
    inputs,
    work,
    pending,
    outputs,
    checkpoints,
    inputPath: (batchId) => path.join(inputs, `${batchId}.input.json`),
    workPath: (batchId) => path.join(work, `${batchId}.work.json`),
    pendingPath: (batchId) => path.join(pending, `${batchId}.output.json`),
    outputPath: (batchId) => path.join(outputs, `${batchId}.output.json`),
    checkpointPath: (batchId) => path.join(checkpoints, `${batchId}.json`)
  };
}
