import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  auditParallelAnnotationPlan, buildLexicalParallelPlan, mergeParallelAnnotation, parallelAnnotationStatus, verifyParallelAnnotation
} from "../lib/lexical/parallelAnnotation.ts";

async function writePrompts() {
  const folder = path.join(process.cwd(), "tmp", "lexical-v1", "parallel-v1", "worker-prompts");
  await mkdir(folder, {recursive: true});
  for (let shard = 0; shard < 8; shard++) {
    const number = String(shard).padStart(2, "0");
    await writeFile(path.join(folder, `shard-${number}.md`), `You are lexical annotation worker ${shard}. Use GPT-6 Sol High only. Work only on shard ${shard}; do not modify code, the parallel plan, global accepted outputs, or another shard. Replace OWNER below with your unique OpenChamber session ID and keep it stable.\n\nLoop:\n1. \`pnpm lexical:agent-next -- --shard ${shard} --owner OWNER\`\n2. Read the complete input_path and annotate every eligible token from its current block. Write output_path JSON with exactly protocol_version, batch_id, stage, generation_version, provenance, batch_plan_version, parallel_plan_version, shard_id, input_signature and blocks (optional schema_version). Each block has block_key and tokens; no expressions.\n3. \`pnpm lexical:agent-accept -- --shard ${shard} --owner OWNER <batch-id>\` (validates, accepts and checkpoints). On failure correct only this batch.\n4. Repeat. A successful checkpoint is NOT a stop condition. Continue until your shard is complete, a genuine technical blocker occurs, or runtime is forcibly ending. Never stop merely to report progress.\n\nDo not edit source/scripts/tests/package.json/plan, another shard, or coordinator manifest. If code is broken, run \`pnpm lexical:agent-abort -- --shard ${shard} --owner OWNER --reason "specific blocker"\`, then report to the coordinator. At end confirm active_batch_id=null, no active lock, no background semantic process. Do not use external LLM providers or lexeme recovery.\n`, {flag: "wx"});
  }
}

async function main() {
  const action = process.argv[2];
  if (action === "build") {
    const {plan, coverage} = await buildLexicalParallelPlan();
    await writePrompts();
    console.log(JSON.stringify({version: plan.parallel_plan_version, shards: plan.shards, coverage}, null, 2));
  } else if (action === "status") {
    console.log(JSON.stringify(await parallelAnnotationStatus(), null, 2));
  } else if (action === "audit") {
    console.log(JSON.stringify(await auditParallelAnnotationPlan(), null, 2));
  } else if (action === "verify") {
    console.log(JSON.stringify(await verifyParallelAnnotation(), null, 2));
  } else if (action === "merge") {
    console.log(JSON.stringify(await mergeParallelAnnotation(), null, 2));
  } else {
    throw new Error("Usage: pnpm lexical:parallel-{build|audit|status|verify|merge}");
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
