import { prepareNextLexicalAgentBatch } from "../lib/lexical/agentProtocol.ts";
import { nextParallelAnnotationBatch } from "../lib/lexical/parallelAnnotation.ts";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function main() {
  if (option("--shard") !== null) {
    const shard = Number(option("--shard"));
    const owner = option("--owner");
    if (!owner) throw new Error("Usage: pnpm lexical:agent-next -- --shard N --owner <unique-session-id>");
    console.log(JSON.stringify(await nextParallelAnnotationBatch(shard, owner) ?? { stage: "shard_complete", shard_id: shard }, null, 2));
    return;
  }
  const batch = await prepareNextLexicalAgentBatch();
  console.log(JSON.stringify(batch ?? { stage: "finalize", message: "All semantic agent batches are accepted." }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
