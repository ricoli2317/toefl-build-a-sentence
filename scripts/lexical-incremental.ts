import { execFile, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  readJsonl,
  fileExists,
  readRequiredJson,
  sha256,
  sha256File,
  writeAtomic,
  writeJsonAtomic,
  writeJsonlAtomic
} from "../lib/lexical/incremental/artifacts.ts";
import { buildAnnotationStage, validateAnnotationStageOutput } from "../lib/lexical/incremental/annotationStage.ts";
import { buildMweStage, validateMweStageOutput, type IncrementalMweCheckpoint } from "../lib/lexical/incremental/mweStage.ts";
import {
  applyIncrementalMweQaDecision,
  buildMweQaStage,
  mweQaExpressionIdentity,
  validateMweQaStageOutput,
  type IncrementalQaRecord
} from "../lib/lexical/incremental/mweQaStage.ts";
import {
  assertStageComplete,
  abortStageBatch,
  acceptStageBatch,
  loadStage,
  nextStageBatch,
  readStageCheckpoint,
  stageStatus,
  verifyStageCheckpoints,
  type IncrementalStagePlanBatch
} from "../lib/lexical/incremental/stageRunner.ts";
import { buildDeltaPlan } from "../lib/lexical/incremental/deltaPlan.ts";
import {
  assertProductionBaselineIntegrity,
  blockIdentityKey,
  productionBaselineHashes,
  legacyProductionBaselineHashes,
  productionHealth,
  readFullProductionSnapshot,
  sortBlocks,
  sortEntries,
  sortOccurrences,
  type ProductionBlockRow,
  type ProductionEntryRow,
  type ProductionOccurrenceRow
} from "../lib/lexical/incremental/productionBaseline.server.ts";
import {
  consolidateIncrementalDelta,
  deriveIncrementalOccurrence,
  occurrenceIdentityOf
} from "../lib/lexical/incremental/consolidation.ts";
import { assembleDeltaArtifacts } from "../lib/lexical/incremental/assemble.ts";
import { bindImportBaseline, fullSnapshotHashes, type FullProductionSnapshot } from "../lib/lexical/incremental/importBaseline.ts";
import { baselineRowsSha256 } from "../lib/lexical/incremental/baselineHash.ts";
import { preflightIncrementalImport } from "../lib/lexical/incremental/importPreflight.ts";
import { applyReviewedEntryIdentities, type EntryIdentityResolution } from "../lib/lexical/incremental/identityReview.ts";
import { runDeltaQa } from "../lib/lexical/incremental/deltaQa.ts";
import { buildIncrementalImportSql, incrementalImportPlanDescription, type IncrementalImportDataset } from "../lib/lexical/incremental/importer.ts";
import { incrementalFile, INCREMENTAL_STAGES, type IncrementalStage } from "../lib/lexical/incremental/paths.ts";
import { enumerateCanonicalLexicalBlocks } from "../lib/lexical/enumerateCanonicalBlocks.server.ts";
import { loadCanonicalLexicalInputs } from "../lib/lexical/loadCanonicalInputs.server.ts";
import { tokenizeCanonicalBlocks } from "../lib/lexical/tokenize.ts";
import { productionId, BLOCK_COLUMNS, ENTRY_COLUMNS, OCCURRENCE_COLUMNS } from "../lib/lexical/production.ts";
import { LEXICAL_GENERATION_VERSION, type LexicalOccurrenceArtifact } from "../lib/lexical/generationTypes.ts";
import type { CanonicalLexicalBlock } from "../lib/lexical/types.ts";
import { createServiceSupabase } from "../lib/supabase/server.ts";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const file = (...parts: string[]) => incrementalFile(ROOT, ...parts);

type DeltaPlanArtifact = ReturnType<typeof buildDeltaPlan>;

function argValue(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function gitCommit() {
  try {
    return (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ROOT })).stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readCanonicalBlocksArtifact(): Promise<CanonicalLexicalBlock[]> {
  const rows = await readJsonl<{
    source_type: CanonicalLexicalBlock["sourceType"];
    source_item_id: string;
    content_block_id: string;
    block_kind: string;
    text: string;
    anchors?: CanonicalLexicalBlock["anchors"];
  }>(file("canonical-blocks.jsonl"));
  return rows.map((row) => ({
    sourceType: row.source_type,
    sourceItemId: row.source_item_id,
    contentBlockId: row.content_block_id,
    blockKind: row.block_kind,
    text: row.text,
    anchors: row.anchors
  }));
}

function canonicalSignature(blocks: CanonicalLexicalBlock[]) {
  return baselineRowsSha256([...blocks].sort((left, right) => {
    const a = `${left.sourceType}:${left.sourceItemId}:${left.contentBlockId}`;
    const b = `${right.sourceType}:${right.sourceItemId}:${right.contentBlockId}`;
    return a < b ? -1 : a > b ? 1 : 0;
  }).map(block => ({ source_type: block.sourceType, source_item_id: block.sourceItemId, content_block_id: block.contentBlockId,
    block_kind: block.blockKind, text: block.text, anchors: block.anchors ?? [] })));
}

async function verifyLiveCanonical(db: ReturnType<typeof createServiceSupabase>, expected: CanonicalLexicalBlock[]) {
  const current = enumerateCanonicalLexicalBlocks(await loadCanonicalLexicalInputs(db, { assetBaseUrl: process.env.READING_ASSET_BASE_URL }));
  if (canonicalSignature(current) !== canonicalSignature(expected)) throw new Error("Canonical source drifted since planning; refuse stale delta publication/import.");
}

async function loadDeltaPlanArtifact() {
  return await readRequiredJson<DeltaPlanArtifact>(file("delta-plan.json"));
}

function deltaBlockKeys(plan: DeltaPlanArtifact) {
  return plan.new_blocks.concat(plan.changed_blocks).map((block) =>
    `${block.source_type}:${block.source_item_id}:${block.content_block_id}`);
}

function deltaWorks(plan: DeltaPlanArtifact, canonicalBlocks: CanonicalLexicalBlock[]) {
  const targets = new Set(deltaBlockKeys(plan));
  const blocks = canonicalBlocks.filter((block) => targets.has(`${block.sourceType}:${block.sourceItemId}:${block.contentBlockId}`));
  if (blocks.length !== targets.size) throw new Error("Canonical blocks do not cover every delta block.");
  return tokenizeCanonicalBlocks(blocks);
}

async function commandPlan() {
  if (await fileExists(file("delta-plan.json"))) throw new Error("Delta plan already exists; never overwrite an active generation workspace.");
  const db = createServiceSupabase();
  console.log("Reading production lexical baseline (read-only)...");
  const { blocks, entries, occurrences } = await readFullProductionSnapshot(db);
  const health = assertProductionBaselineIntegrity({ blocks, entries, occurrences });
  const fullHashes = productionBaselineHashes({ blocks, entries, occurrences });
  console.log(`Production baseline: ${health.entries} entries / ${health.blocks} blocks / ${health.occurrences} occurrences.`);
  console.log("Loading canonical sources (read-only) and enumerating blocks...");
  const input = await loadCanonicalLexicalInputs(db, {
    assetBaseUrl: process.env.READING_ASSET_BASE_URL,
    onProgress: (message) => console.log(`  ${message}`)
  });
  const canonicalBlocks = enumerateCanonicalLexicalBlocks(input);
  const baseline = {
    captured_at: new Date().toISOString(),
    git_commit: await gitCommit(),
    counts: { entries: entries.length, blocks: blocks.length, occurrences: occurrences.length },
    hashes: fullHashes
  };
  const plan = buildDeltaPlan({ canonicalBlocks, productionBlocks: blocks, productionBaseline: baseline });

  const deltaKeys = new Set(plan.new_blocks.concat(plan.changed_blocks, plan.removed_blocks).map((block) =>
    `${block.source_type}:${block.source_item_id}:${block.content_block_id}`));
  const unrelatedBlockRows = sortBlocks(blocks.filter((block) => !deltaKeys.has(blockIdentityKey(block))));
  const unrelatedOccurrenceRows = sortOccurrences(occurrences.filter((occurrence) =>
    !deltaKeys.has(blockIdentityKey(occurrence))));
  (plan.production_baseline as Record<string, unknown>).unrelated = {
    blocks_sha256: baselineRowsSha256(unrelatedBlockRows),
    occurrences_sha256: baselineRowsSha256(unrelatedOccurrenceRows),
    excluded_blocks: deltaKeys.size
  };

  await Promise.all([
    writeJsonlAtomic(file("production-blocks.jsonl"), sortBlocks(blocks)),
    writeJsonlAtomic(file("production-entries.jsonl"), sortEntries(entries)),
    writeJsonlAtomic(file("canonical-blocks.jsonl"), canonicalBlocks.map((block) => ({
      source_type: block.sourceType,
      source_item_id: block.sourceItemId,
      content_block_id: block.contentBlockId,
      block_kind: block.blockKind,
      source_text_hash: sha256(block.text),
      text: block.text,
      anchors: block.anchors ?? []
    }))),
    writeJsonAtomic(file("delta-plan.json"), plan)
  ]);
  console.log(JSON.stringify({
    production_counts: plan.production_baseline["counts"] ?? null,
    per_source_counts: plan.per_source_counts,
    delta: {
      new_blocks: plan.new_blocks.length,
      changed_blocks: plan.changed_blocks.length,
      removed_blocks: plan.removed_blocks.length,
      unchanged_blocks: plan.unchanged_blocks.length,
      new_items: plan.delta_items.new.length,
      changed_items: plan.delta_items.changed.length,
      removed_items: plan.delta_items.removed.length
    },
    rap_title_delta_blocks: plan.new_blocks.concat(plan.changed_blocks).filter((block) => block.block_kind === "rap_title").length
  }, null, 2));
  await commandCaptureBaseline();
}

/** Read-only strengthening of the first in-progress plan; immutable stage inputs are preserved. */
async function commandCaptureBaseline() {
  if (await fileExists(file("baseline-snapshot.json"))) throw new Error("Full baseline snapshot already exists and is immutable.");
  const plan = await loadDeltaPlanArtifact();
  console.log("Capturing full production rows (read-only; includes semantic JSON, context_text and timestamps)...");
  const snapshot = await readFullProductionSnapshot(createServiceSupabase());
  assertProductionBaselineIntegrity(snapshot);
  const planned = (plan.production_baseline as { hashes: ReturnType<typeof productionBaselineHashes> }).hashes;
  if (planned.blocks_sha256.length === 32) {
    const legacy = legacyProductionBaselineHashes(snapshot);
    if (legacy.blocks_md5 !== planned.blocks_sha256 || legacy.entries_md5 !== planned.entries_sha256 || legacy.occurrences_md5 !== planned.occurrences_sha256) throw new Error("Legacy production baseline drift; refuse to capture a replacement baseline.");
  } else if (JSON.stringify(productionBaselineHashes(snapshot)) !== JSON.stringify(planned)) {
    throw new Error("Production baseline drift; refuse to capture a replacement baseline.");
  }
  // The initial legacy entry artifact did already include all semantic JSON fields.
  const oldEntries = await readJsonl<ProductionEntryRow>(file("production-entries.jsonl"));
  const projectedEntries = snapshot.entries.map(row => Object.fromEntries(Object.keys(oldEntries[0] ?? {}).map(key => [key, (row as unknown as Record<string, unknown>)[key]])));
  if (baselineRowsSha256(projectedEntries) !== baselineRowsSha256(oldEntries)) throw new Error("Production entry semantic fields drifted since the original plan.");
  const artifacts = [];
  for (const name of ["blocks", "entries", "occurrences"] as const) {
    const artifactPath = `baseline-full-${name}.jsonl`;
    await writeJsonlAtomic(file(artifactPath), snapshot[name]);
    artifacts.push({ artifact_path: artifactPath, sha256: await sha256File(file(artifactPath)) });
  }
  const metadata = { version: "lexical-incremental-full-baseline-v1", captured_at: new Date().toISOString(),
    delta_plan_sha256: await sha256File(file("delta-plan.json")), hashes: fullSnapshotHashes(snapshot), artifacts };
  await writeJsonAtomic(file("baseline-snapshot.json"), metadata);
  console.log(JSON.stringify({ full_baseline_captured: true, counts: { entries: snapshot.entries.length, blocks: snapshot.blocks.length, occurrences: snapshot.occurrences.length } }, null, 2));
}

async function loadFullBaseline(): Promise<{ snapshot: FullProductionSnapshot; metadata: Record<string, any> }> {
  const metadata = await readRequiredJson<Record<string, any>>(file("baseline-snapshot.json"));
  if (metadata.version !== "lexical-incremental-full-baseline-v1" || metadata.delta_plan_sha256 !== await sha256File(file("delta-plan.json"))) throw new Error("Full baseline snapshot/plan binding mismatch.");
  for (const artifact of metadata.artifacts) {
    if (await sha256File(file(artifact.artifact_path)) !== artifact.sha256) throw new Error(`Immutable full baseline changed: ${artifact.artifact_path}.`);
  }
  const snapshot = {
    blocks: await readJsonl<ProductionBlockRow>(file("baseline-full-blocks.jsonl")),
    entries: await readJsonl<ProductionEntryRow>(file("baseline-full-entries.jsonl")),
    occurrences: await readJsonl<ProductionOccurrenceRow>(file("baseline-full-occurrences.jsonl"))
  };
  if (JSON.stringify(fullSnapshotHashes(snapshot)) !== JSON.stringify(metadata.hashes)) throw new Error("Full baseline hash contract mismatch.");
  return { snapshot, metadata };
}

async function commandVerifyBaseline() {
  const { metadata } = await loadFullBaseline();
  const db = createServiceSupabase();
  const live = await readFullProductionSnapshot(db);
  const health = assertProductionBaselineIntegrity(live);
  const hashes = fullSnapshotHashes(live);
  if (JSON.stringify(hashes) !== JSON.stringify(metadata.hashes)) throw new Error("Production baseline drifted; original snapshot is preserved and must not be rebased silently.");
  await verifyLiveCanonical(db, await readCanonicalBlocksArtifact());
  const report = { verified_at: new Date().toISOString(), full_baseline_sha256_match: true, canonical_match: true,
    health, production_writes: 0, baseline_replaced: false };
  await writeJsonAtomic(file("baseline-live-verification.json"), report);
  console.log(JSON.stringify(report, null, 2));
}

async function commandStageAnnotation() {
  const plan = await loadDeltaPlanArtifact();
  const canonicalBlocks = await readCanonicalBlocksArtifact();
  const works = deltaWorks(plan, canonicalBlocks);
  const stagePlan = await buildAnnotationStage(ROOT, works, await sha256File(file("delta-plan.json")));
  console.log(JSON.stringify({
    stage: "annotation",
    batches: stagePlan.batches.length,
    blocks: works.length,
    eligible_tokens: works.reduce((sum, work) => sum + work.tokens.filter((token) => !token.excluded).length, 0)
  }, null, 2));
}

async function commandStageMwe() {
  await verifyStageCheckpoints(ROOT, "annotation", (output, batch) => validateStageOutput("annotation", batch.batch_id, batch, output));
  const stagePlan = await buildMweStage(ROOT, await sha256File(file("delta-plan.json")));
  console.log(JSON.stringify({ stage: "mwe", batches: stagePlan.batches.length }, null, 2));
}

async function commandStageMweQa() {
  await verifyStageCheckpoints(ROOT, "mwe", (output, batch) => validateStageOutput("mwe", batch.batch_id, batch, output));
  const stagePlan = await buildMweQaStage(ROOT, await sha256File(file("delta-plan.json")));
  console.log(JSON.stringify({ stage: "mwe-qa", batches: stagePlan.batches.length }, null, 2));
}

function requireStage(): IncrementalStage {
  const stage = argValue("stage");
  if (!stage || !(INCREMENTAL_STAGES as readonly string[]).includes(stage)) {
    throw new Error(`--stage must be one of ${INCREMENTAL_STAGES.join(", ")}.`);
  }
  return stage as IncrementalStage;
}

function requireOwner(): string {
  const owner = argValue("owner");
  if (!owner) throw new Error("--owner is required.");
  return owner;
}

async function commandNext() {
  const stage = requireStage();
  const owner = requireOwner();
  console.log(JSON.stringify(await nextStageBatch(ROOT, stage, owner), null, 2));
}

async function validateStageOutput(stage: IncrementalStage, batchId: string, batch: IncrementalStagePlanBatch, output: unknown) {
  if (stage === "annotation") return await validateAnnotationStageOutput(ROOT, batchId, batch, output);
  if (stage === "mwe") return await validateMweStageOutput(ROOT, batchId, batch, output);
  return await validateMweQaStageOutput(ROOT, batchId, batch, output);
}

async function commandAccept() {
  const stage = requireStage();
  const owner = requireOwner();
  const batchId = process.argv.slice(3).find((value, index, values) =>
    !value.startsWith("--") && values[index - 1] !== "--stage" && values[index - 1] !== "--owner" && values[index - 1] !== "--reason");
  if (!batchId) throw new Error("A batch id is required.");
  const result = await acceptStageBatch(ROOT, stage, batchId, owner, async (output, batch) =>
    await validateStageOutput(stage, batchId, batch, output));
  console.log(JSON.stringify(result, null, 2));
}

async function commandAbort() {
  const stage = requireStage();
  const owner = requireOwner();
  const reason = argValue("reason") ?? "";
  console.log(JSON.stringify(await abortStageBatch(ROOT, stage, owner, reason), null, 2));
}

async function commandStatus() {
  const statuses: unknown[] = [];
  for (const stage of INCREMENTAL_STAGES) {
    try {
      statuses.push(await stageStatus(ROOT, stage));
    } catch (error) {
      statuses.push({ stage, error: (error as Error).message });
    }
  }
  let delta: Record<string, number> | null = null;
  try {
    const plan = await loadDeltaPlanArtifact();
    delta = {
      new_blocks: plan.new_blocks.length,
      changed_blocks: plan.changed_blocks.length,
      removed_blocks: plan.removed_blocks.length,
      unchanged_blocks: plan.unchanged_blocks.length
    };
  } catch {
    delta = null;
  }
  console.log(JSON.stringify({ delta, stages: statuses }, null, 2));
}

async function collectAnnotationOccurrences() {
  const { plan } = await loadStage(ROOT, "annotation");
  const occurrences: LexicalOccurrenceArtifact[] = [];
  for (const batch of plan.batches) {
    const checkpoint = await readStageCheckpoint<{ occurrences?: LexicalOccurrenceArtifact[] }>(ROOT, "annotation", batch.batch_id);
    if (!checkpoint?.occurrences) throw new Error(`Missing annotation checkpoint ${batch.batch_id}.`);
    occurrences.push(...checkpoint.occurrences);
  }
  return occurrences;
}

async function collectMweLayer2() {
  const { plan } = await loadStage(ROOT, "mwe");
  const layer2: LexicalOccurrenceArtifact[] = [];
  for (const batch of plan.batches) {
    const checkpoint = await readStageCheckpoint<IncrementalMweCheckpoint>(ROOT, "mwe", batch.batch_id);
    if (!checkpoint?.occurrences) throw new Error(`Missing MWE checkpoint ${batch.batch_id}.`);
    layer2.push(...checkpoint.occurrences.filter((occurrence) => occurrence.layer === 2));
  }
  return layer2;
}

async function collectQaRecords() {
  const { plan } = await loadStage(ROOT, "mwe-qa");
  const records = new Map<string, IncrementalQaRecord>();
  for (const batch of plan.batches) {
    const checkpoint = await readStageCheckpoint<{ records?: IncrementalQaRecord[] }>(ROOT, "mwe-qa", batch.batch_id);
    if (!checkpoint?.records) throw new Error(`Missing MWE QA checkpoint ${batch.batch_id}.`);
    for (const record of checkpoint.records) {
      const id = mweQaExpressionIdentity(record.expression_identity as unknown as Record<string, unknown>).occurrence_id;
      if (records.has(id)) throw new Error(`Duplicate MWE QA record ${id}.`);
      records.set(id, record);
    }
  }
  return records;
}

async function commandFinalize() {
  if (await fileExists(file("manifest.json"))) throw new Error("Publication manifest already exists and is immutable; use a new run for further changes.");
  const plan = await loadDeltaPlanArtifact();
  const { snapshot: fullBaseline, metadata: fullBaselineMetadata } = await loadFullBaseline();
  const canonicalBlocks = await readCanonicalBlocksArtifact();
  const works = deltaWorks(plan, canonicalBlocks);
  for (const stage of INCREMENTAL_STAGES) {
    await verifyStageCheckpoints(ROOT, stage, (output, batch) => validateStageOutput(stage, batch.batch_id, batch, output));
  }
  await assertStageComplete(ROOT, "annotation");
  await assertStageComplete(ROOT, "mwe");
  await assertStageComplete(ROOT, "mwe-qa");

  const annotationOccurrences = await collectAnnotationOccurrences();
  const mweLayer2 = await collectMweLayer2();
  const qaRecords = await collectQaRecords();

  let qaRemoved = 0;
  let qaCorrected = 0;
  let qaPass = 0;
  const finalLayer2: LexicalOccurrenceArtifact[] = [];
  for (const occurrence of mweLayer2) {
    const id = mweQaExpressionIdentity(occurrence as unknown as Record<string, unknown>).occurrence_id;
    const record = qaRecords.get(id);
    if (!record) throw new Error(`MWE occurrence ${id} has no QA record.`);
    const applied = applyIncrementalMweQaDecision(
      occurrence as unknown as LexicalOccurrenceArtifact & Record<string, unknown>, record);
    if (!applied) qaRemoved += 1;
    else {
      finalLayer2.push(applied as LexicalOccurrenceArtifact);
      if (record.verdict === "PASS") qaPass += 1;
      else qaCorrected += 1;
    }
  }
  if (qaRecords.size !== mweLayer2.length) throw new Error("MWE QA records do not match the accepted Layer-2 occurrence set.");

  let occurrences = [...annotationOccurrences, ...finalLayer2]
    .map(deriveIncrementalOccurrence)
    .sort((left, right) => occurrenceIdentityOf(left) < occurrenceIdentityOf(right) ? -1 : 1);

  const productionEntries = await readJsonl<ProductionEntryRow>(file("production-entries.jsonl"));
  const resolutions = await fileExists(file("entry-identity-resolutions.jsonl")) ? await readJsonl<EntryIdentityResolution>(file("entry-identity-resolutions.jsonl")) : [];
  const reviewed = applyReviewedEntryIdentities({ works, occurrences, productionEntries, resolutions, provenance: (await loadStage(ROOT, "annotation")).plan.provenance });
  occurrences = reviewed.occurrences;
  const { identityVariantAssignments } = reviewed;
  const consolidation = consolidateIncrementalDelta({ occurrences, productionEntries, identityVariantAssignments });
  await writeJsonlAtomic(file("delta-consolidation-input.jsonl"), occurrences);
  await writeJsonAtomic(file("delta-entry-conflicts.json"), consolidation.conflicts);
  if (consolidation.conflicts.length) {
    throw new Error(`Consolidation has ${consolidation.conflicts.length} unresolved conflicts; review delta-entry-conflicts.json. No import-ready manifest is produced.`);
  }

  // Live read-only re-verification immediately before import-ready publication.
  const db = createServiceSupabase();
  const liveSnapshot = await readFullProductionSnapshot(db);
  const { blocks: liveBlocks, entries: liveEntries, occurrences: liveOccurrences } = liveSnapshot;
  const liveHashes = fullSnapshotHashes(liveSnapshot);
  const plannedHashes = fullBaselineMetadata.hashes;
  const baselineDrift = liveHashes.blocks_sha256 !== plannedHashes.blocks_sha256
    ? "production blocks changed since delta generation"
    : liveHashes.entries_sha256 !== plannedHashes.entries_sha256
      ? "production entries changed since delta generation"
      : liveHashes.occurrences_sha256 !== plannedHashes.occurrences_sha256
        ? "production occurrences changed since delta generation"
        : null;
  const liveHealth = productionHealth({ blocks: liveBlocks, entries: liveEntries, occurrences: liveOccurrences });
  await verifyLiveCanonical(db, canonicalBlocks);

  const newEntryIds = new Set(consolidation.newEntries.map((entry) => entry.entry_id));
  const entriesUnrelatedRows = sortEntries(fullBaseline.entries
    .filter((entry) => !newEntryIds.has(entry.entry_id)));
  const deltaKeys = new Set(plan.new_blocks.concat(plan.changed_blocks, plan.removed_blocks).map(blockIdentityKey));
  const unrelatedMeta = {
    blocks_sha256: baselineRowsSha256(sortBlocks(fullBaseline.blocks.filter(row => !deltaKeys.has(blockIdentityKey(row))))),
    occurrences_sha256: baselineRowsSha256(sortOccurrences(fullBaseline.occurrences.filter(row => !deltaKeys.has(blockIdentityKey(row)))))
  };

  const baselineCounts = (plan.production_baseline as { counts: { entries: number; blocks: number; occurrences: number } }).counts;
  const assembled = assembleDeltaArtifacts({
    plan,
    consolidation,
    baselineCounts,
    unrelated: unrelatedMeta,
    entriesUnrelatedSha256: baselineRowsSha256(entriesUnrelatedRows),
    liveOccurrences
  });

  const qa = runDeltaQa({
    deltaPlan: plan,
    works,
    occurrences,
    consolidation,
    artifactBlockKeys: assembled.artifactBlockKeys,
    productionHealth: liveHealth,
    baselineDrift,
    layer2Qa: { removed: qaRemoved, corrected: qaCorrected, pass: qaPass, status: mweLayer2.length ? "applied" : "not_applicable" },
    productionOccurrences: liveOccurrences,
    productionEntries: liveEntries,
    productionBlocks: liveBlocks
  });

  const boundDataset = bindImportBaseline({
    entries: assembled.entryRows,
    blocks: assembled.blockRows,
    occurrences: assembled.occurrenceRows,
    removed: assembled.removedRows,
    delta: assembled.deltaRows,
    meta: assembled.meta,
    entryColumns: assembled.columns.entryColumns,
    blockColumns: assembled.columns.blockColumns,
    occurrenceColumns: assembled.columns.occurrenceColumns
  }, fullBaseline);
  const importSql = buildIncrementalImportSql(boundDataset);

  await Promise.all([
    writeJsonlAtomic(file("delta-source-blocks.jsonl"), boundDataset.blocks),
    writeJsonlAtomic(file("delta-occurrences.jsonl"), assembled.occurrenceRows),
    writeJsonlAtomic(file("delta-new-entries.jsonl"), assembled.entryRows),
    writeJsonlAtomic(file("delta-entry-mapping.jsonl"), assembled.mappingRows),
    writeJsonlAtomic(file("delta-removals.jsonl"), assembled.removedRows),
    writeJsonlAtomic(file("delta-import-plan.jsonl"), boundDataset.delta),
    writeJsonAtomic(file("delta-import-meta.json"), boundDataset.meta),
    writeJsonlAtomic(file("delta-identity-resolutions.jsonl"), resolutions),
    writeJsonAtomic(file("delta-qa.json"), qa),
    writeAtomic(file("delta-import.sql"), importSql)
  ]);

  const artifactNames = [
    "delta-plan.json", "canonical-blocks.jsonl", "production-blocks.jsonl", "production-entries.jsonl",
    "delta-source-blocks.jsonl", "delta-occurrences.jsonl", "delta-new-entries.jsonl",
    "delta-entry-mapping.jsonl", "delta-removals.jsonl", "delta-import-plan.jsonl", "delta-import-meta.json", "delta-qa.json", "delta-import.sql",
    "baseline-snapshot.json", "baseline-full-blocks.jsonl", "baseline-full-entries.jsonl", "baseline-full-occurrences.jsonl", "delta-identity-resolutions.jsonl"
  ];
  const artifacts = [];
  for (const name of artifactNames) {
    artifacts.push({ artifact_path: name, sha256: await sha256File(file(name)) });
  }
  const manifest = {
    version: "lexical-incremental-import-manifest-v1",
    created_at: new Date().toISOString(),
    git_commit: await gitCommit(),
    delta_plan_sha256: await sha256File(file("delta-plan.json")),
    complete: true,
    import_ready: qa.import_ready,
    unresolved_conflicts: qa.consolidation.unresolved_conflicts,
    coverage: qa.delta_coverage,
    consolidation: {
      reused_entries: consolidation.reusedEntries.length,
      new_entries: assembled.entryRows.length,
      reused_entry_keys: consolidation.reusedEntries.map((entry) => entry.entry_key),
      reviewed_identity_occurrences: reviewed.reviewed
    },
    counts: {
      before: baselineCounts,
      new_entries: assembled.entryRows.length,
      new_blocks: plan.new_blocks.length,
      changed_blocks: plan.changed_blocks.length,
      removed_blocks: plan.removed_blocks.length,
      unchanged_blocks: plan.unchanged_blocks.length,
      delta_occurrences: assembled.occurrenceRows.length,
      after: {
        entries: Number(assembled.meta.final_entries_count),
        blocks: Number(assembled.meta.final_blocks_count),
        occurrences: Number(assembled.meta.final_occurrences_count)
      }
    },
    baseline: {
      captured_at: (plan.production_baseline as { captured_at: string }).captured_at,
      live_reverified_at: new Date().toISOString(),
      drift: baselineDrift,
      full_snapshot_captured_at: fullBaselineMetadata.captured_at,
      hash_contract: "sha256-full-row-utf8-framed-v1",
      original_plan_hash_contract: (plan.production_baseline as { hashes: { blocks_sha256: string } }).hashes.blocks_sha256.length === 32
        ? "initial-plan-legacy-md5-labels-preserved-for-stage-immutability; strengthened-by-full-sha256-snapshot"
        : "sha256-full-row-utf8-framed-v1",
      unrelated_blocks_sha256: boundDataset.meta.unrelated_blocks_sha256,
      entries_unrelated_sha256: boundDataset.meta.entries_unrelated_sha256,
      unrelated_occurrences_sha256: boundDataset.meta.unrelated_occurrences_sha256
    },
    stage_plans: {
      annotation_sha256: await sha256File(path.join(incrementalFile(ROOT, "agent", "annotation"), "plan.json")),
      mwe_sha256: await sha256File(path.join(incrementalFile(ROOT, "agent", "mwe"), "plan.json")),
      mwe_qa_sha256: await sha256File(path.join(incrementalFile(ROOT, "agent", "mwe-qa"), "plan.json"))
    },
    artifacts
  };
  await writeJsonAtomic(file("manifest.json"), manifest);
  console.log(JSON.stringify({
    import_ready: manifest.import_ready,
    unresolved_conflicts: manifest.unresolved_conflicts,
    counts: manifest.counts,
    qa: {
      delta_coverage: qa.delta_coverage,
      consolidation: { ...qa.consolidation, conflicts: qa.consolidation.conflicts.map((conflict) => conflict.reasons) },
      layer2: qa.layer2,
      write_safety: qa.write_safety
    }
  }, null, 2));
}

async function loadImportDataset(): Promise<{ dataset: IncrementalImportDataset; manifest: Record<string, any>; sql: string }> {
  const manifest = await readRequiredJson<Record<string, any>>(file("manifest.json"));
  const requiredArtifacts = ["delta-plan.json", "canonical-blocks.jsonl", "production-blocks.jsonl", "production-entries.jsonl",
    "delta-source-blocks.jsonl", "delta-occurrences.jsonl", "delta-new-entries.jsonl", "delta-entry-mapping.jsonl", "delta-removals.jsonl",
    "delta-import-plan.jsonl", "delta-import-meta.json", "delta-qa.json", "delta-import.sql", "baseline-snapshot.json",
    "baseline-full-blocks.jsonl", "baseline-full-entries.jsonl", "baseline-full-occurrences.jsonl", "delta-identity-resolutions.jsonl"];
  const artifactNames = manifest.artifacts?.map((artifact: Record<string, unknown>) => artifact.artifact_path);
  if (manifest.version !== "lexical-incremental-import-manifest-v1" || !Array.isArray(artifactNames)
    || artifactNames.length !== requiredArtifacts.length || new Set(artifactNames).size !== requiredArtifacts.length
    || requiredArtifacts.some(name => !artifactNames.includes(name))) throw new Error("Incomplete import manifest artifact contract.");
  for (const artifact of manifest.artifacts) {
    const actual = await sha256File(file(artifact.artifact_path));
    if (actual !== artifact.sha256) throw new Error(`Publication artifact changed: ${artifact.artifact_path}`);
  }
  const entries = await readJsonl<Record<string, any>>(file("delta-new-entries.jsonl"));
  const qa = await readRequiredJson<Record<string, any>>(file("delta-qa.json"));
  if (!qa.import_ready || qa.consolidation.unresolved_conflicts !== 0 || manifest.unresolved_conflicts !== 0) throw new Error("Publication QA is not import-ready.");
  const blocks = await readJsonl<Record<string, any>>(file("delta-source-blocks.jsonl"));
  const occurrences = await readJsonl<Record<string, any>>(file("delta-occurrences.jsonl"));
  const removed = await readJsonl<Record<string, any>>(file("delta-removals.jsonl"));
  const meta: Record<string, string> = {
    unrelated_blocks_sha256: manifest.baseline.unrelated_blocks_sha256,
    entries_unrelated_sha256: manifest.baseline.entries_unrelated_sha256,
    unrelated_occurrences_sha256: manifest.baseline.unrelated_occurrences_sha256,
    reused_entries: String(manifest.consolidation.reused_entries),
    final_entries_count: String(manifest.counts.after.entries),
    final_blocks_count: String(manifest.counts.after.blocks),
    final_occurrences_count: String(manifest.counts.after.occurrences)
  };
  if (baselineRowsSha256([await readRequiredJson(file("delta-import-meta.json"))]) !== baselineRowsSha256([meta])) throw new Error("Manifest/import metadata mismatch.");
  const deltaRows = await readJsonl<Record<string, any>>(file("delta-import-plan.jsonl"));
  const dataset: IncrementalImportDataset = {
    entries,
    blocks,
    occurrences,
    removed,
    delta: deltaRows,
    meta,
    entryColumns: [...ENTRY_COLUMNS],
    blockColumns: [...BLOCK_COLUMNS],
    occurrenceColumns: [...OCCURRENCE_COLUMNS]
  };
  return { dataset, manifest, sql: buildIncrementalImportSql(dataset) };
}

async function commandImport() {
  const { dataset, manifest, sql } = await loadImportDataset();
  if (!manifest.complete || !manifest.import_ready) {
    throw new Error(`Incremental publication is not import-ready (${manifest.unresolved_conflicts} unresolved conflicts).`);
  }
  const storedSql = await readFile(file("delta-import.sql"), "utf8");
  if (storedSql !== sql) throw new Error("Stored delta-import.sql does not reproduce from its artifacts.");
  const { snapshot: baseline } = await loadFullBaseline();
  const db = createServiceSupabase();
  const preflight = preflightIncrementalImport(dataset, baseline, await readFullProductionSnapshot(db));
  await verifyLiveCanonical(db, await readCanonicalBlocksArtifact());
  if (!process.argv.includes("--write")) {
    console.log(JSON.stringify({ ...incrementalImportPlanDescription(dataset), preflight, manifest: "lexical-incremental-import-manifest-v1" }, null, 2));
    return;
  }
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is required for the explicit --write operation");
  const parsed = new URL(url);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw new Error("SUPABASE_DB_URL must be a Postgres connection URL");
  const result = spawnSync("psql", ["-X", "--no-password", "-v", "ON_ERROR_STOP=1", "-f", file("delta-import.sql")], {
    stdio: "inherit",
    env: {
      ...process.env,
      PGHOST: parsed.hostname,
      PGPORT: parsed.port || "5432",
      PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
      PGUSER: decodeURIComponent(parsed.username),
      PGPASSWORD: decodeURIComponent(parsed.password),
      PGSSLMODE: parsed.searchParams.get("sslmode") || "require"
    }
  });
  if (result.error) throw new Error("psql could not start; install the Postgres client");
  if (result.status !== 0) throw new Error("Incremental import failed; the transaction was rolled back");
  console.log("Incremental lexical import committed and verified inside one transaction.");
}

async function main() {
  const command = process.argv[2];
  switch (command) {
    case "plan": return await commandPlan();
    case "capture-baseline": return await commandCaptureBaseline();
    case "verify-baseline": return await commandVerifyBaseline();
    case "stage-annotation": return await commandStageAnnotation();
    case "stage-mwe": return await commandStageMwe();
    case "stage-mwe-qa": return await commandStageMweQa();
    case "next": return await commandNext();
    case "accept": return await commandAccept();
    case "abort": return await commandAbort();
    case "status": return await commandStatus();
    case "verify-checkpoints": {
      const stage = requireStage();
      return console.log(JSON.stringify(await verifyStageCheckpoints(ROOT, stage, (output, batch) => validateStageOutput(stage, batch.batch_id, batch, output)), null, 2));
    }
    case "finalize": return await commandFinalize();
    case "import": return await commandImport();
    default:
      throw new Error("Usage: lexical-incremental {plan|capture-baseline|verify-baseline|stage-annotation|stage-mwe|stage-mwe-qa|next|accept|abort|status|verify-checkpoints|finalize|import}");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
