import { abortParallelAnnotationBatch } from "../lib/lexical/parallelAnnotation.ts";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function main() {
  const shard = Number(option("--shard"));
  const owner = option("--owner");
  const reason = option("--reason");
  if (!owner || !reason || !Number.isInteger(shard)) {
    throw new Error("Usage: pnpm lexical:agent-abort -- --shard N --owner <session-id> --reason <blocker>");
  }
  console.log(JSON.stringify(await abortParallelAnnotationBatch(shard, owner, reason), null, 2));
}
main().catch(error => {console.error(error); process.exitCode = 1;});
