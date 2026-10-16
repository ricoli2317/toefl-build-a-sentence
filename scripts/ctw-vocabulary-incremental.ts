import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { digest, canonicalSources, planCtw, prepareCtw, verifyCtw, type CtwSnapshot, type CtwCheckpoint, type CtwPlan,
  type CtwReview, type CtwPublication } from "../lib/ctw-vocabulary/incremental.ts";
import { CTW_SNAPSHOT_SQL, buildCtwDeltaSql } from "../lib/ctw-vocabulary/incrementalSql.ts";
import { runPostgres } from "../lib/vocabulary-maintenance/postgres.ts";
import { readCtwSnapshotViaApi } from "../lib/ctw-vocabulary/incrementalSnapshot.server.ts";
import { createServiceSupabase } from "../lib/supabase/server.ts";

const args = process.argv.slice(2), command = args.shift();
const allowed: Record<string, string[]> = {
  capture: ["output", "read-live"], bootstrap: ["snapshot", "output", "ack-reviewed-history"],
  plan: ["snapshot", "checkpoint", "out"], prepare: ["out", "review"], verify: ["out", "snapshot", "read-live"],
  import: ["out", "write"], "post-verify": ["out", "read-live"]
};
const flags = new Set(["read-live", "write", "ack-reviewed-history"]), options = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  const key = args[i].replace(/^--/, "");
  if (!args[i].startsWith("--") || !allowed[command ?? ""]?.includes(key) || options.has(key)) throw new Error(`Unknown/duplicate argument: ${args[i]}`);
  const value = flags.has(key) ? "true" : args[++i];
  if (!value || value.startsWith("--")) throw new Error(`Missing --${key} value`);
  options.set(key, value);
}
function required(key: string) { const value = options.get(key); if (!value) throw new Error(`--${key} required`); return value; }
const load = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, "utf8"));
async function immutable(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(file, text, { flag: "wx" }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(file, "utf8") !== text) throw new Error(`Refuse to overwrite changed artifact: ${file}`); }
}
const json = (file: string, value: unknown) => immutable(file, JSON.stringify(value, null, 2) + "\n");
async function live(): Promise<CtwSnapshot> {
  if (!options.has("read-live") && !(command === "import" && options.has("write"))) throw new Error("Live read requires --read-live (import requires --write)");
  return process.env.SUPABASE_DB_URL ? JSON.parse(runPostgres(CTW_SNAPSHOT_SQL, true)) : await readCtwSnapshotViaApi(createServiceSupabase());
}
const outFile = (name: string) => path.join(required("out"), name);
async function publication() {
  const p = await load<CtwPublication>(outFile("publication.json"));
  if (await readFile(outFile("delta-import.sql"), "utf8") !== buildCtwDeltaSql(p)) throw new Error("SQL/publication binding mismatch");
  return p;
}
async function main() {
  if (command === "capture") { await json(required("output"), await live()); return { captured: true, production_writes: 0 }; }
  if (command === "bootstrap") {
    if (!options.has("ack-reviewed-history")) throw new Error("Bootstrap only from the separately reviewed historically synced canonical inventory, never the full current corpus");
    const snapshot = await load<CtwSnapshot>(required("snapshot"));
    await json(required("output"), { version: "ctw-incremental-checkpoint-v1", sources: canonicalSources(snapshot.canonical) });
    return { bootstrap: true, production_writes: 0 };
  }
  if (command === "plan") {
    const plan = planCtw(await load<CtwSnapshot>(required("snapshot")), await load<CtwCheckpoint>(required("checkpoint")));
    await json(outFile("plan.json"), plan);
    await json(outFile("review-template.json"), { version: "ctw-incremental-review-v1", plan_sha256: digest(plan), reviewer: "",
      decisions: [], new_words: [], pending: plan.candidates });
    return { new_canonical: plan.new_canonical, changed: plan.changed, removed: plan.removed, pending: plan.candidates.length };
  }
  if (command === "prepare") {
    const p = prepareCtw(await load<CtwPlan>(outFile("plan.json")), await load<CtwReview>(required("review")));
    await json(outFile("publication.json"), p);
    await immutable(outFile("delta-import.sql"), buildCtwDeltaSql(p));
    await json(outFile("append-preview.json"), { reused: p.reuse, new_senses: p.senses, new_entries: p.new_entries, cefr_memberships: p.memberships });
    return { ready: true, reused: p.reuse.length, sense_updates: p.senses.length, new_words: p.new_entries.length };
  }
  if (command === "verify" || command === "post-verify") {
    if (options.has("snapshot") && options.has("read-live")) throw new Error("Choose snapshot or live, not both");
    const p = await publication();
    const result = verifyCtw(p, options.has("snapshot") ? await load<CtwSnapshot>(required("snapshot")) : await live(), command === "post-verify");
    return { ...result, publication_sha256: digest(p), next_checkpoint: command === "post-verify" ? p.next_checkpoint : undefined };
  }
  if (command === "import") {
    const p = await publication();
    if (!options.has("write")) return { sql_ready: true, databaseExecuted: false, next: "verify --read-live, then import --write" };
    if (!process.env.SUPABASE_DB_URL) throw new Error("SUPABASE_DB_URL required for explicit --write");
    verifyCtw(p, await live());
    runPostgres(buildCtwDeltaSql(p), false);
    return { committed: true, transactional_post_verify: true, checkpoint_updated: false };
  }
  throw new Error("Usage: ctw-vocabulary:incremental capture|bootstrap|plan|prepare|verify|import|post-verify (see docs/vocabulary-maintenance.md)");
}
main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
