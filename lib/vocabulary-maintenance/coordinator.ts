import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { digest } from "../ctw-vocabulary/incremental.ts";
import { writeJsonAtomic, fileExists } from "../lexical/incremental/artifacts.ts";

export const STAGES = ["plan", "prepare", "verify", "import", "post-verify"] as const;
export type Stage = typeof STAGES[number];
export type Branch = "ctw" | "lexical";
export type Receipt = { status: "succeeded" | "failed"; attempts: number; at: string; result?: unknown; error?: string };
export type MaintenanceState = { version: "vocabulary-maintenance-v1"; run: string; config_sha256: string;
  branches: Record<Branch, { stages: Partial<Record<Stage, Receipt>>; completed?: boolean }> };
export type StageResult = { verified?: boolean; checkpoint?: unknown; [key: string]: unknown };
export type Adapter = { run: (branch: Branch, stage: Stage) => Promise<StageResult>;
  validate: (branch: Branch, stage: Stage, result: unknown) => Promise<void>;
  checkpoint: (branch: Branch, result: StageResult) => Promise<void> };
export const safeRun = (run: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(run)) throw new Error("Safe run ID (1-100 characters) required");
  return run;
};

/** Single local writer; only own lock removed. No DB transactions coupled across branches. */
export async function withMaintenanceLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const file = path.join(root, ".lock");
  try { await writeFile(file, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }), { flag: "wx" }); }
  catch { throw new Error(`Maintenance locked: ${file}. If interrupted, inspect owner before manually removing a stale lock.`); }
  try { return await work(); } finally { await unlink(file); }
}

export async function coordinate(input: { root: string; run: string; config: unknown; stage: Stage; branches: Branch[]; adapter: Adapter }) {
  const { root, run, config, stage, branches, adapter } = input;
  safeRun(run);
  const file = path.join(root, "runs", run, "report.json"), configHash = digest(config);
  let state: MaintenanceState = { version: "vocabulary-maintenance-v1", run, config_sha256: configHash,
    branches: { ctw: { stages: {} }, lexical: { stages: {} } } };
  if (await fileExists(file)) state = JSON.parse(await readFile(file, "utf8"));
  if (state.version !== "vocabulary-maintenance-v1" || state.run !== run || state.config_sha256 !== configHash) throw new Error("Immutable run/config mismatch; use original config or a new run");
  for (const branch of branches) {
    const branchState = state.branches[branch], prior = branchState.stages[stage];
    try {
      // An already completed branch is never reimported because the other branch is retrying.
      // Still check immutable bindings: a cached success is not permission to modify artifacts.
      if (prior?.status === "succeeded") {
        await adapter.validate(branch, stage, prior.result);
        continue;
      }
      const index = STAGES.indexOf(stage);
      if (index > 0 && branchState.stages[STAGES[index - 1]]?.status !== "succeeded") throw new Error(`Complete ${STAGES[index - 1]} first for ${branch}`);
      for (const previous of STAGES.slice(0, index)) await adapter.validate(branch, previous, branchState.stages[previous]?.result);
      const result = await adapter.run(branch, stage);
      if (stage === "post-verify") {
        if (result.verified !== true) throw new Error("Post-verification did not prove success; checkpoint preserved");
        // Crash after DB commit or after checkpoint write is retry-safe; post-verify is read-only.
        await adapter.checkpoint(branch, result);
        branchState.completed = true;
      }
      branchState.stages[stage] = { status: "succeeded", attempts: (prior?.attempts ?? 0) + 1, at: new Date().toISOString(), result };
    } catch (error) {
      branchState.stages[stage] = { status: "failed", attempts: (prior?.attempts ?? 0) + 1, at: new Date().toISOString(), error: (error as Error).message };
      branchState.completed = false;
    }
    // Persist after EACH branch, even if the next one throws/is interrupted.
    await writeJsonAtomic(file, state);
  }
  return state;
}
