import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildVocabularyImportSql, loadVocabularySource } from "../lib/ctw-vocabulary/import.ts";

// Explicit input/output paths; no .env, credentials, network or automatic execution.
const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== "--mode" || !["initial", "append"].includes(args[1])
  || args[2] !== "--input" || args[4] !== "--output") {
  throw new Error("Usage: pnpm ctw-vocabulary:import --mode initial|append --input FILE.json --output FILE.sql");
}
const mode = args[1] as "initial" | "append", input = resolve(args[3]), output = resolve(args[5]);
if (input === output) throw new Error("Input and output must differ");
const { rows, sha256 } = loadVocabularySource(readFileSync(input), mode);
writeFileSync(output, buildVocabularyImportSql(rows, sha256, mode), { flag: "wx" });
console.log(JSON.stringify({ mode, entries: rows.length, irregularEntries: rows.filter(row => row.irregular_forms.length).length,
  sha256, output, databaseExecuted: false }, null, 2));
