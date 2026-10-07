import { finalizeProduction } from "../lib/lexical/production.ts";
async function main() { console.log(JSON.stringify(await finalizeProduction(), null, 2)); }
main().catch(error => { console.error(error.message); process.exitCode = 1; });
