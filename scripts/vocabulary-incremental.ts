import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { coordinate, safeRun, STAGES, withMaintenanceLock, type Adapter, type Branch, type Stage } from "../lib/vocabulary-maintenance/coordinator.ts";
import { digest, type CtwCheckpoint, type CtwPublication } from "../lib/ctw-vocabulary/incremental.ts";
import { fileExists, sha256File, writeJsonAtomic } from "../lib/lexical/incremental/artifacts.ts";

type Config = { version: "vocabulary-maintenance-config-v1"; run: string;
  ctw: { snapshot: string; checkpoint: string; review: string }; lexical: { run: string } };
const args = process.argv.slice(2), command = args.shift(), opts = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, "");
  if (!args[i].startsWith("--") || !["config", "branch", "read-live", "write"].includes(key) || opts.has(key)) throw new Error(`Unknown/duplicate argument ${args[i]}`);
  const val = ["read-live", "write"].includes(key) ? "true" : args[++i];
  if (!val || val.startsWith("--")) throw new Error(`Missing --${key}`);
  opts.set(key, val);
}
const load = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, "utf8"));
const root = process.cwd(), stateRoot = path.join(root, "tmp/vocabulary-maintenance");
async function main() {
  const configPath = opts.get("config");
  if (!configPath) throw new Error("Usage: vocabulary:incremental plan|prepare|verify|import|post-verify|report --config FILE [--branch ctw|lexical|both] [--read-live] [--write]");
  const c = await load<Config>(configPath);
  if (c.version !== "vocabulary-maintenance-config-v1") throw new Error("Invalid config version");
  safeRun(c.run); safeRun(c.lexical.run);
  const runRoot = path.join(stateRoot, "runs", c.run), ctwRoot = path.join(runRoot, "ctw");
  const lexicalRoot = path.join(root, "tmp/lexical-incremental/runs", c.lexical.run);
  const selection = opts.get("branch") ?? "both";
  if (!["ctw", "lexical", "both"].includes(selection)) throw new Error("--branch ctw|lexical|both required");
  const branches: Branch[] = selection === "both" ? ["ctw", "lexical"] : [selection as Branch];
  if (command === "report") {
    console.log(JSON.stringify(await load(path.join(runRoot, "report.json")), null, 2)); return;
  }
  if (!(STAGES as readonly string[]).includes(command ?? "")) throw new Error("Unknown maintenance stage");
  const stage = command as Stage;
  // Authorization is checked before invoking ANY adapter, even on retries.
  if (stage === "import" && !opts.has("write")) throw new Error("Unified import requires explicit --write; use verify for dry-run");
  if (stage !== "import" && opts.has("write")) throw new Error("--write only belongs to import");
  if (stage !== "import" && (branches.includes("lexical") || stage === "verify" || stage === "post-verify") && !opts.has("read-live")) throw new Error("This stage performs live read-only checks; explicit --read-live required");

  function child(branch: Branch, childArgs: string[]) {
    const script = branch === "ctw" ? "ctw-vocabulary-incremental.ts" : "lexical-incremental.ts";
    const env = { ...process.env, LEXICAL_INCREMENTAL_RUN: c.lexical.run };
    const result = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--experimental-strip-types", path.join(root, "scripts", script), ...childArgs],
      { cwd: root, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      // Raw child diagnostics may contain live data/connection details; keep them out of the unified report.
      throw new Error(`${branch} ${childArgs[0]} failed. Run that documented branch command locally for diagnostics; artifacts/checkpoints preserved.`);
    }
    return result.stdout.trim();
  }
  const ctw = (...args: string[]) => child("ctw", [...args, "--out", ctwRoot]);
  async function bindings(branch: Branch, s: Stage) {
    const files = branch === "ctw"
      ? s === "plan" ? [path.join(ctwRoot, "plan.json")] : [path.join(ctwRoot, "plan.json"), path.join(ctwRoot, "publication.json"), path.join(ctwRoot, "delta-import.sql")]
      : s === "plan" ? [path.join(lexicalRoot, "delta-plan.json"), path.join(lexicalRoot, "baseline-snapshot.json"),
        ...["blocks", "entries", "occurrences"].map(k => path.join(lexicalRoot, `baseline-full-${k}.jsonl`)), path.join(lexicalRoot, "canonical-blocks.jsonl")]
        : [path.join(lexicalRoot, "manifest.json"), path.join(lexicalRoot, "delta-import.sql")];
    if (branch === "lexical" && s === "plan") files.push(path.join(lexicalRoot, "production-blocks.jsonl"), path.join(lexicalRoot, "production-entries.jsonl"));
    if (branch === "lexical" && s !== "plan") {
      const manifest = await load<{ artifacts: { artifact_path: string }[] }>(path.join(lexicalRoot, "manifest.json"));
      for (const a of manifest.artifacts) {
        if (!/^[a-zA-Z0-9_-]+\.(json|jsonl|sql)$/.test(a.artifact_path)) throw new Error("Invalid lexical artifact path");
        files.push(path.join(lexicalRoot, a.artifact_path));
      }
    }
    return Object.fromEntries(await Promise.all(files.map(async f => [path.relative(root, f), await sha256File(f)])));
  }
  const adapter: Adapter = {
    validate: async (b, s, value) => {
      const expected = (value as { bindings?: unknown })?.bindings;
      if (!expected || digest(await bindings(b, s)) !== digest(expected)) throw new Error(`${b} immutable ${s} artifact changed`);
    },
    run: async (b, s) => {
      let proof: Record<string, unknown> = {};
      if (b === "ctw") {
        if (s === "plan") ctw("plan", "--snapshot", c.ctw.snapshot, "--checkpoint", c.ctw.checkpoint);
        if (s === "prepare") ctw("prepare", "--review", c.ctw.review);
        if (s === "verify") ctw("verify", "--read-live");
        if (s === "import") ctw("import", "--write");
        if (s === "post-verify") proof = JSON.parse(ctw("post-verify", "--read-live"));
      } else {
        if (s === "plan") {
          if (!await fileExists(path.join(lexicalRoot, "delta-plan.json"))) child(b, ["plan"]);
          // Handles interruption after immutable plan but before full-baseline capture.
          if (!await fileExists(path.join(lexicalRoot, "baseline-snapshot.json"))) child(b, ["capture-baseline"]);
          child(b, ["verify-baseline"]);
        }
        if (s === "prepare") {
          if (!await fileExists(path.join(lexicalRoot, "manifest.json"))) {
            for (const [name, build] of [["annotation", "stage-annotation"], ["mwe", "stage-mwe"], ["mwe-qa", "stage-mwe-qa"]]) {
              if (!await fileExists(path.join(lexicalRoot, "agent", name, "plan.json"))) child(b, [build]);
              // Expected blocker until human/agent semantic work has been accepted. Retry resumes, not regenerates.
              const checked = JSON.parse(child(b, ["verify-checkpoints", "--stage", name]));
              if (checked.verified !== checked.total) throw new Error(`lexical ${name} awaits reviewed semantic outputs. Use existing next/accept; retry prepare afterwards.`);
            }
            child(b, ["finalize"]);
          }
          child(b, ["import"]); // existing QA/manifest loader + live dry-run
        }
        if (s === "verify") child(b, ["import"]);
        if (s === "import") child(b, ["import", "--write"]);
        if (s === "post-verify") proof = JSON.parse(child(b, ["post-verify"]));
      }
      if (b === "ctw") {
        if (s === "plan") {
          const p = await load<CtwPublication["plan"]>(path.join(ctwRoot, "plan.json"));
          proof.summary = { new_canonical: p.new_canonical.length, unchanged: p.unchanged.length, changed: p.changed.length,
            removed: p.removed.length, pending_contexts: p.candidates.length };
        } else {
          const p = await load<CtwPublication>(path.join(ctwRoot, "publication.json"));
          proof.summary = { reused_contexts: p.reuse.length, new_senses: p.senses.reduce((n, x) => n + x.senses.length, 0),
            new_entries: p.new_entries.length, new_memberships: p.memberships.length };
        }
      } else {
        const p = await load<Record<string, any>>(path.join(lexicalRoot, s === "plan" ? "delta-plan.json" : "manifest.json"));
        proof.summary = s === "plan" ? { new_blocks: p.new_blocks.length, changed_blocks: p.changed_blocks.length,
          removed_blocks: p.removed_blocks.length, unchanged_blocks: p.unchanged_blocks.length } : p.counts;
      }
      return { ...proof, artifact_directory: b === "ctw" ? ctwRoot : lexicalRoot, bindings: await bindings(b, s) };
    },
    checkpoint: async (b, result) => {
      if (b === "ctw") {
        const p = await load<CtwPublication>(path.join(ctwRoot, "publication.json"));
        const current = await load<CtwCheckpoint>(c.ctw.checkpoint);
        if (digest(current) !== digest(p.plan.previous) && digest(current) !== digest(p.next_checkpoint)) throw new Error("CTW success checkpoint advanced elsewhere; refuse overwrite");
        if (digest(result.next_checkpoint) !== digest(p.next_checkpoint)) throw new Error("CTW verification/checkpoint binding mismatch");
        await writeJsonAtomic(c.ctw.checkpoint, p.next_checkpoint);
      }
      // Lexical retains its own canonical + full-row production snapshots; pointer is reporting only, never a rebase.
      await writeJsonAtomic(path.join(stateRoot, `${b}-last-success.json`), { run: c.run, branch: b,
        lexical_run: b === "lexical" ? c.lexical.run : undefined, proof: result });
    }
  };
  await withMaintenanceLock(stateRoot, async () => {
    const result = await coordinate({ root: stateRoot, run: c.run, config: c, stage, branches, adapter });
    console.log(JSON.stringify(result, null, 2));
    if (branches.some(b => result.branches[b].stages[stage]?.status !== "succeeded")) process.exitCode = 1;
  });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
