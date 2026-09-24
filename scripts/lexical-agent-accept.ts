import { acceptLexicalAgentBatch, lexicalAgentBatchIdFromArgs } from "../lib/lexical/agentProtocol.ts";
import { acceptParallelAnnotationBatch } from "../lib/lexical/parallelAnnotation.ts";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function main() {
  if (option("--shard") !== null) {
    const shard = Number(option("--shard"));
    const owner = option("--owner");
    const batchId = process.argv.at(-1);
    if (!owner || !batchId || batchId.startsWith("--")) {
      throw new Error("Usage: pnpm lexical:agent-accept -- --shard N --owner <unique-session-id> <batch-id>");
    }
    console.log(JSON.stringify(await acceptParallelAnnotationBatch(shard, batchId, owner), null, 2));
    return;
  }
  const batchId = lexicalAgentBatchIdFromArgs(process.argv.slice(2));
  if (!batchId) throw new Error("Usage: pnpm lexical:agent-accept -- <batch-id>");
  const checkpoint = await acceptLexicalAgentBatch(batchId);
  console.log(JSON.stringify({ accepted: batchId, stage: checkpoint.stage }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
