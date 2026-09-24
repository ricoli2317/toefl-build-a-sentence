import { finalizeLexicalAgentArtifacts } from "../lib/lexical/finalizeAgent.ts";

async function main() {
  const result = await finalizeLexicalAgentArtifacts();
  console.log(JSON.stringify(result.completion, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
