import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PRODUCTION_DIRECTORY } from "../lib/lexical/production.ts";

async function main() {
  const manifest = JSON.parse(await readFile(path.join(PRODUCTION_DIRECTORY, "manifest.json"), "utf8"));
  if (!manifest.complete || !manifest.import_ready || manifest.qa.entries !== 13043 || manifest.qa.occurrences !== 149411) throw new Error("Invalid publication manifest");
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(path.join(PRODUCTION_DIRECTORY, artifact.artifact_path));
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error(`Publication artifact changed: ${artifact.artifact_path}`);
  }
  if (!process.argv.includes("--write")) {
    console.log(JSON.stringify({ dry_run: true, ...manifest.qa, transaction: "single staged transaction", writes: 0 }));
    return;
  }
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is required for the explicit --write operation");
  const parsed = new URL(url);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("SUPABASE_DB_URL must be a Postgres connection URL");
  // Password stays in the process environment, never command arguments or output.
  const result = spawnSync("psql", ["-X", "--no-password", "-v", "ON_ERROR_STOP=1", "-f", path.join(PRODUCTION_DIRECTORY, "import.sql")], {
    stdio: "inherit", env: { ...process.env, PGHOST: parsed.hostname, PGPORT: parsed.port || "5432",
      PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)), PGUSER: decodeURIComponent(parsed.username),
      PGPASSWORD: decodeURIComponent(parsed.password), PGSSLMODE: parsed.searchParams.get("sslmode") || "require" }
  });
  if (result.error) throw new Error("psql could not start; install the Postgres client");
  if (result.status !== 0) throw new Error("Import failed; transaction was rolled back");
  console.log("LEXICAL V1 imported and transaction-validated: 13043 entries / 149411 occurrences / 8791 source blocks.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
