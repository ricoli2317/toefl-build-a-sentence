import { spawnSync } from "node:child_process";

/** Never pass secrets in process arguments or echo database errors containing connection strings. */
export function runPostgres(sql: string, readOnly: boolean): string {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL required for explicitly authorized live operation");
  const u = new URL(url);
  if (!["postgres:", "postgresql:"].includes(u.protocol)) throw new Error("Expected Postgres connection URL");
  const result = spawnSync("psql", ["-X", "--no-password", "-qAt", "-v", "ON_ERROR_STOP=1"], {
    input: readOnly ? `begin isolation level repeatable read read only; set local timezone='UTC';\n${sql};\ncommit;\n` : sql,
    encoding: "utf8", maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, PGHOST: u.hostname, PGPORT: u.port || "5432", PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
      PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGSSLMODE: u.searchParams.get("sslmode") || "require" }
  });
  if (result.error) throw new Error("psql could not start; install the PostgreSQL client");
  if (result.status !== 0) {
    const code = result.stderr.match(/CTW_[A-Z_]+/)?.[0];
    throw new Error(code ?? "PostgreSQL operation failed; transaction rolled back. Inspect locally without exposing credentials.");
  }
  return result.stdout.trim();
}
