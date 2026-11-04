#!/usr/bin/env node
/**
 * Static checks for the formal Phase 4 migration. No database connection, no SQL
 * execution: this only tokenizes the files and asserts their shape.
 *
 *   node scripts/check-phase4-sql.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MIGRATION = "supabase/writing_correction_phase4/10_writing_correction_phase4.sql";

function tokenize(sql) {
  const statements = [];
  const forbiddenTokens = [];
  let current = "";
  let parens = 0;
  let dollarTag = null;
  let index = 0;
  const push = () => {
    const text = current.trim();
    if (text) statements.push(text);
    current = "";
  };
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) {
        current += dollarTag;
        index += dollarTag.length;
        dollarTag = null;
        continue;
      }
      current += char;
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (char === "'") {
      current += char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          current += "''";
          index += 2;
          continue;
        }
        current += sql[index];
        if (sql[index] === "'") { index += 1; break; }
        index += 1;
      }
      continue;
    }
    if (char === "$") {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(index));
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        index += dollarTag.length;
        continue;
      }
    }
    if (char === "(") parens += 1;
    if (char === ")") parens -= 1;
    if (char === ";" && parens === 0) {
      push();
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }
  push();
  return { statements, parens, forbiddenTokens };
}

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

const failures = [];
function check(name, condition, detail = "") {
  if (condition) return;
  failures.push(detail ? `${name}: ${detail}` : name);
}

for (const file of [MIGRATION]) {
  const full = path.join(ROOT, file);
  check(`${file} exists`, fs.existsSync(full));
  if (!fs.existsSync(full)) continue;
  const sql = fs.readFileSync(full, "utf8");
  const { statements, parens } = tokenize(sql);
  check(`${file} parentheses balanced`, parens === 0, `balance ${parens}`);
  check(`${file} has statements`, statements.length > 0);
  console.log(`${file}: ${statements.length} statement(s), paren balance ${parens}`);
}

const migration = fs.readFileSync(path.join(ROOT, MIGRATION), "utf8");
const migrationCode = stripComments(migration);
check("migration has BEGIN", /\bBEGIN\s*;/i.test(migrationCode));
check("migration has COMMIT", /\bCOMMIT\s*;/i.test(migrationCode));
check("migration has no ROLLBACK", !/\bROLLBACK\b/i.test(migrationCode));
check(
  "migration does not alter ordinary writing tables",
  !/ALTER\s+TABLE\s+public\.(writing_reviews|writing_attempts)\b/i.test(migrationCode)
);
check(
  "migration does not drop ordinary objects",
  !/\bDROP\s+(TABLE|FUNCTION|POLICY|INDEX)\b/i.test(migrationCode)
    && !/\bDROP\s+TRIGGER[^;]*ON\s+public\.(writing_reviews|writing_attempts)\b/i.test(migrationCode)
);
check(
  "migration does not create RLS policies",
  !/\bCREATE\s+POLICY\b/i.test(migrationCode)
);
check(
  "migration only targets the correction table",
  (migrationCode.match(/\bCREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?public\.([a-z_]+)/gi) ?? [])
    .every((match) => match.includes("writing_correction_reviews"))
);

// Keep the formal migration's security contracts executable without shipping
// the one-time manual catalog acceptance query as a project dependency.
check("migration requires the closed gate", /tgname = 'writing_attempts_correction_closed_gate'[\s\S]*tgenabled = 'O'/.test(migrationCode));
check("migration enables server-only RLS", /ALTER TABLE public\.writing_correction_reviews ENABLE ROW LEVEL SECURITY/.test(migrationCode));
check("migration revokes browser access", /REVOKE ALL ON public\.writing_correction_reviews FROM PUBLIC, anon, authenticated/.test(migrationCode));
check("migration grants only expected service operations", /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.writing_correction_reviews TO service_role/.test(migrationCode));
check("migration keeps one review per attempt and cascade FK", /attempt_id uuid NOT NULL UNIQUE\s+REFERENCES public\.writing_attempts\(attempt_id\) ON DELETE CASCADE/.test(migrationCode));
check("migration binds the update trigger", /CREATE TRIGGER writing_correction_reviews_touch[\s\S]*EXECUTE FUNCTION public\.touch_writing_correction_reviews\(\)/.test(migrationCode));
check("migration keeps published snapshot constraints", /CONSTRAINT writing_correction_reviews_publish_state CHECK/.test(migrationCode) && /status = 'published' AND published_review IS NOT NULL AND published_at IS NOT NULL/.test(migrationCode));

if (failures.length > 0) {
  console.error("\nFAILED");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("\nAll Phase 4 SQL static checks passed.");
}
