import { mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createServiceSupabase } from "../lib/supabase/server.ts";
import { loadCanonicalLexicalInputs } from "../lib/lexical/loadCanonicalInputs.server.ts";
import { enumerateCanonicalLexicalBlocks } from "../lib/lexical/enumerateCanonicalBlocks.server.ts";
import { tokenizeCanonicalBlock } from "../lib/lexical/tokenize.ts";
import { parseLexicalAnnotationPayload, validateAndMaterializeBlockAnnotation } from "../lib/lexical/annotation.ts";
import { tokenAnnotationsFromOccurrences } from "../lib/lexical/agentProtocol.ts";
import { lexicalEntryKey, type LexicalOccurrenceArtifact } from "../lib/lexical/generationTypes.ts";
import { hyphenatedCompounds, hyphenatedCoverage, assertHyphenatedCoverage } from "../lib/lexical/hyphenated.ts";
import { incrementalFile, incrementalRoot } from "../lib/lexical/incremental/paths.ts";
import { incrementalAgentProvenance } from "../lib/lexical/incremental/envelope.ts";
import { lexicalSemanticProvenanceMatches } from "../lib/lexical/provenance.ts";
import { readJsonl, readRequiredJson, writeJsonAtomic, writeJsonlAtomic, writeAtomic, sha256File, fileExists } from "../lib/lexical/incremental/artifacts.ts";
import { readFullProductionSnapshot, assertProductionBaselineIntegrity } from "../lib/lexical/incremental/productionBaseline.server.ts";
import { fullSnapshotHashes, type FullProductionSnapshot } from "../lib/lexical/incremental/importBaseline.ts";
import { consolidateIncrementalDelta, deltaEntryRow, deltaOccurrenceRow, occurrenceIdentityOf } from "../lib/lexical/incremental/consolidation.ts";
import { validateHyphenRepair, validateHyphenRepairSemanticQa, preflightHyphenRepair, buildHyphenRepairSql, type HyphenRepairDataset } from "../lib/lexical/incremental/hyphenRepair.ts";
import type { CanonicalLexicalBlock } from "../lib/lexical/types.ts";

const file = (...parts: string[]) => incrementalFile(process.cwd(), ...parts);
async function snapshot(): Promise<FullProductionSnapshot> {
  return { entries: await readJsonl(file("baseline-entries.jsonl")), blocks: await readJsonl(file("baseline-blocks.jsonl")), occurrences: await readJsonl(file("baseline-occurrences.jsonl")) };
}
async function liveCanonical() {
  return enumerateCanonicalLexicalBlocks(await loadCanonicalLexicalInputs(createServiceSupabase(), { assetBaseUrl: process.env.READING_ASSET_BASE_URL, onProgress: console.log }));
}
async function audit() {
  const sourceRun = process.argv[process.argv.indexOf("--source-run") + 1];
  if (!process.argv.includes("--source-run") || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(sourceRun ?? "")) throw Error("Supply --source-run SAFE_RUN_NAME.");
  await mkdir(incrementalRoot(), { recursive: false });
  const original = await readRequiredJson<any>(path.join("tmp/lexical-incremental/runs", sourceRun, "delta-plan.json"));
  const scope = new Set([...original.delta_items.new, ...original.delta_items.changed]);
  console.log("Reading fresh full production baseline (read-only)...");
  const baseline = await readFullProductionSnapshot(createServiceSupabase());
  assertProductionBaselineIntegrity(baseline);
  await Promise.all(Object.entries(baseline).map(([name, rows]) => writeJsonlAtomic(file(`baseline-${name}.jsonl`), rows)));
  await writeJsonAtomic(file("baseline.json"), { captured_at: new Date().toISOString(), hashes: fullSnapshotHashes(baseline) });
  const blocks = (await liveCanonical()).filter(b => scope.has(`${b.sourceType}:${b.sourceItemId}`));
  if (!blocks.length || Array.from(scope).some(id => !blocks.some(b => `${b.sourceType}:${b.sourceItemId}` === id))) throw Error("Canonical audit scope is incomplete.");
  await writeJsonAtomic(file("canonical.json"), blocks);
  const records = blocks.flatMap(b => hyphenatedCompounds(b).map(c => ({ ...c, missing: hyphenatedCoverage([b], baseline.occurrences).missing.some(m => m.start_offset === c.start_offset && m.end_offset === c.end_offset) })));
  const summary = ["rdl", "rap"].map(type => ({ source_type: type, items: new Set(blocks.filter(b => b.sourceType === type).map(b => b.sourceItemId)).size,
    blocks: blocks.filter(b => b.sourceType === type).length, compounds: records.filter(c => c.source_type === type).length,
    missing: records.filter(c => c.source_type === type && c.missing).length }));
  await writeJsonAtomic(file("audit.json"), { captured_at: new Date().toISOString(), source_run: sourceRun, scope: Array.from(scope), records, summary });
  console.log(JSON.stringify({ summary, production_writes: 0 }, null, 2));
}

async function finalize() {
  if (await fileExists(file("repair-manifest.json"))) throw Error("Repair publication is immutable; use a new run.");
  const baseline = await snapshot();
  assertProductionBaselineIntegrity(baseline);
  const metadata = await readRequiredJson<any>(file("baseline.json"));
  if (JSON.stringify(fullSnapshotHashes(baseline)) !== JSON.stringify(metadata.hashes)) throw Error("Captured baseline changed.");
  const blocks = await readRequiredJson<CanonicalLexicalBlock[]>(file("canonical.json"));
  const missing = hyphenatedCoverage(blocks, baseline.occurrences).missing;
  const annotations = await readRequiredJson<any>(file("compound-annotations.json"));
  if (!lexicalSemanticProvenanceMatches(annotations.provenance, incrementalAgentProvenance())) throw Error("Repair semantic provenance mismatch.");
  const semanticQa = await readRequiredJson<any>(file("compound-semantic-qa.json"));
  for (const name of ["canonical.json", "audit.json", "compound-annotations.json", "baseline-occurrences.jsonl"]) {
    if (semanticQa.input_sha256?.[name] !== await sha256File(file(name))) throw Error("Repair semantic QA input binding changed.");
  }
  const semanticQaResult = validateHyphenRepairSemanticQa(semanticQa, annotations);
  const targeted = blocks.filter(b => missing.some(m => m.source_type === b.sourceType && m.source_item_id === b.sourceItemId && m.content_block_id === b.contentBlockId));
  if (!Array.isArray(annotations.blocks) || annotations.blocks.length !== targeted.length || new Set(annotations.blocks.map((b: any) => b.block_key)).size !== targeted.length) throw Error("Repair annotation block coverage mismatch.");
  const occurrences: LexicalOccurrenceArtifact[] = [];
  const entries = new Map(baseline.entries.map(e => [e.entry_id, e]));
  for (const b of targeted) {
    const work = tokenizeCanonicalBlock(b);
    const layer1 = work.tokens.filter(t => !t.excluded).map(t => {
      const o = baseline.occurrences.find(o => o.source_type === t.sourceType && o.source_item_id === t.sourceItemId && o.content_block_id === t.contentBlockId && o.start_offset === t.startOffset && o.end_offset === t.endOffset);
      const e = o && entries.get(o.entry_id);
      if (!o || !e) throw Error(`Missing frozen component token: ${t.candidateId}`);
      return { ...o, layer: 1, canonical_expression: e.canonical_expression, lemma: e.lemma,
        expression_type: e.expression_type, normalized_expression: e.normalized_expression, entry_key: lexicalEntryKey(e.normalized_expression, e.expression_type as any) } as unknown as LexicalOccurrenceArtifact;
    });
    const [tokens] = tokenAnnotationsFromOccurrences([work], layer1);
    const raw = annotations.blocks.find((a: any) => a.block_key === tokens.block_key);
    if (!raw || Object.keys(raw).sort().join(",") !== "block_key,expressions" || !Array.isArray(raw.expressions)) throw Error("Repair annotations must be expressions-only.");
    // Existing component rows are read-only alignment evidence, not newly generated
    // annotations. Do not renormalize legacy entry conventions (e.g. led / lead).
    // Replay the frozen semantic parser over ALL new expressions, then the frozen
    // materializer over their exact spans with the untouched component token evidence.
    const [parsed] = parseLexicalAnnotationPayload({ blocks: [{ block_key: tokens.block_key, tokens: [], expressions: raw.expressions }] });
    const componentTokens = tokens.tokens.map(token => {
      if (token.expression_type !== "word" && token.expression_type !== "proper_noun") throw Error("Frozen component is not a lexical token.");
      return { ...token, expression_type: token.expression_type };
    });
    const materialized = validateAndMaterializeBlockAnnotation(work, { ...parsed, tokens: componentTokens });
    occurrences.push(...materialized.filter(o => o.layer === 2));
  }
  const consolidated = consolidateIncrementalDelta({ occurrences, productionEntries: baseline.entries });
  if (consolidated.conflicts.length) throw Error(`Repair identity conflicts: ${JSON.stringify(consolidated.conflicts)}`);
  const data: HyphenRepairDataset = { version: "lexical-hyphen-repair-v1", blocks,
    entries: consolidated.newEntries.map(deltaEntryRow),
    occurrences: consolidated.occurrences.map(o => deltaOccurrenceRow(o, consolidated.assignments.get(occurrenceIdentityOf(o))!.entry_id)),
    baseline: { hashes: metadata.hashes, counts: { entries: baseline.entries.length, blocks: baseline.blocks.length, occurrences: baseline.occurrences.length } } };
  validateHyphenRepair(data, baseline);
  await writeJsonAtomic(file("repair-dataset.json"), data);
  await writeAtomic(file("repair-import.sql"), buildHyphenRepairSql(data));
  const artifacts = [];
  for (const name of ["baseline.json", "baseline-entries.jsonl", "baseline-blocks.jsonl", "baseline-occurrences.jsonl", "canonical.json", "audit.json", "compound-annotations.json", "compound-semantic-qa.json", "repair-dataset.json", "repair-import.sql"]) artifacts.push({ path: name, sha256: await sha256File(file(name)) });
  const coverage = assertHyphenatedCoverage(blocks, [...baseline.occurrences, ...data.occurrences]);
  const manifest = { version: data.version, created_at: new Date().toISOString(), import_ready: true, provenance: annotations.provenance,
    added_occurrences: data.occurrences.length, new_entries: data.entries.length, reused_entries: consolidated.reusedEntries.length,
    hyphenated_compounds: coverage.total, missing_after: 0, semantic_qa: semanticQaResult, existing_rows_updated_or_deleted: 0, artifacts };
  await writeJsonAtomic(file("repair-manifest.json"), manifest);
  console.log(JSON.stringify(manifest, null, 2));
}

async function importRepair() {
  const manifest = await readRequiredJson<any>(file("repair-manifest.json"));
  const required = ["baseline.json", "baseline-entries.jsonl", "baseline-blocks.jsonl", "baseline-occurrences.jsonl", "canonical.json", "audit.json", "compound-annotations.json", "compound-semantic-qa.json", "repair-dataset.json", "repair-import.sql"];
  if (manifest.version !== "lexical-hyphen-repair-v1" || !manifest.import_ready || !Array.isArray(manifest.artifacts)
    || manifest.artifacts.length !== required.length || new Set(manifest.artifacts.map((a: any) => a.path)).size !== required.length
    || required.some(name => !manifest.artifacts.some((a: any) => a.path === name))) throw Error("Incomplete repair manifest.");
  for (const artifact of manifest.artifacts) if (await sha256File(file(artifact.path)) !== artifact.sha256) throw Error("Repair artifact changed.");
  const data = await readRequiredJson<HyphenRepairDataset>(file("repair-dataset.json"));
  const baseline = await snapshot();
  validateHyphenRepair(data, baseline);
  if (await readFile(file("repair-import.sql"), "utf8") !== buildHyphenRepairSql(data)) throw Error("Repair SQL does not reproduce.");
  const preflight = preflightHyphenRepair(data, baseline, await readFullProductionSnapshot(createServiceSupabase()));
  const current = await liveCanonical();
  for (const b of data.blocks) {
    const live = current.find(c => c.sourceType === b.sourceType && c.sourceItemId === b.sourceItemId && c.contentBlockId === b.contentBlockId);
    if (!live || live.text !== b.text || JSON.stringify(live.anchors) !== JSON.stringify(b.anchors)) throw Error("Repair canonical drift.");
  }
  if (!process.argv.includes("--write")) {
    console.log(JSON.stringify({ dry_run: true, preflight, canonical_compatible: true, added_occurrences: data.occurrences.length,
      new_entries: data.entries.length, existing_rows_updated_or_deleted: 0, production_writes: 0 }, null, 2)); return;
  }
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw Error("SUPABASE_DB_URL is required for explicit --write.");
  const parsed = new URL(url);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw Error("Invalid Postgres URL.");
  const result = spawnSync("psql", ["-X", "--no-password", "-v", "ON_ERROR_STOP=1", "-f", file("repair-import.sql")], { stdio: "inherit", env: { ...process.env,
    PGHOST: parsed.hostname, PGPORT: parsed.port || "5432", PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)), PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password), PGSSLMODE: parsed.searchParams.get("sslmode") || "require" } });
  if (result.error || result.status !== 0) throw Error("Repair import failed; transaction rolled back.");
  console.log("Append-only compound repair committed and verified.");
}
async function main() {
  if (!process.env.LEXICAL_INCREMENTAL_RUN?.trim()) throw Error("A unique LEXICAL_INCREMENTAL_RUN is required.");
  if (process.argv[2] === "audit") return audit();
  if (process.argv[2] === "finalize") return finalize();
  if (process.argv[2] === "import") return importRepair();
  throw Error("Usage: lexical-hyphen-repair {audit --source-run RUN|finalize|import [--write]}");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
