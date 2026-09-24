import { access, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildLexicalAgentWorkBatchSpecs,
  LEXICAL_AGENT_BATCH_PLAN_V2,
  LEXICAL_AGENT_PROTOCOL_VERSION,
  lexicalAgentPaths,
  loadLexicalAgentCorpus,
  type LexicalAgentBatchPlan
} from "../lib/lexical/agentProtocol.ts";
import { lexicalSemanticProvenanceMatches } from "../lib/lexical/provenance.ts";

function tokenIdentity(token: {
  sourceType: string;
  sourceItemId: string;
  contentBlockId: string;
  startOffset: number;
  endOffset: number;
}) {
  return `${token.sourceType}:${token.sourceItemId}:${token.contentBlockId}:${token.startOffset}:${token.endOffset}`;
}

function occurrenceIdentity(occurrence: Record<string, unknown>) {
  return `${occurrence.source_type}:${occurrence.source_item_id}:${occurrence.content_block_id}:${occurrence.start_offset}:${occurrence.end_offset}`;
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function main() {
  const root = process.cwd();
  const paths = lexicalAgentPaths(root);
  try {
    await access(paths.activeLock);
    throw new Error("Cannot create a new batch plan while an agent batch is active.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const works = await loadLexicalAgentCorpus(root);
  const legacySpecs = buildLexicalAgentWorkBatchSpecs(works, "annotation");
  const checkpointDir = path.join(paths.checkpointRoot, "annotation");
  const checkpointFiles = new Set((await readdir(checkpointDir)).filter((name) => name.endsWith(".json")));
  let acceptedPrefix = 0;
  const acceptedOccurrenceIds = new Set<string>();
  for (const spec of legacySpecs) {
    const fileName = `${spec.batchId}.json`;
    if (!checkpointFiles.has(fileName)) break;
    const checkpoint = JSON.parse(await readFile(path.join(checkpointDir, fileName), "utf8")) as Record<string, unknown>;
    if (
      checkpoint.protocol_version !== LEXICAL_AGENT_PROTOCOL_VERSION ||
      checkpoint.batch_id !== spec.batchId ||
      checkpoint.input_signature !== spec.inputSignature ||
      !lexicalSemanticProvenanceMatches(checkpoint.provenance) ||
      !Array.isArray(checkpoint.occurrences)
    ) throw new Error(`Accepted checkpoint ${spec.batchId} failed v2 plan validation.`);
    const expected = new Set(spec.works!.flatMap((work) =>
      work.tokens.filter((token) => !token.excluded).map(tokenIdentity)
    ));
    const actual = (checkpoint.occurrences as Array<Record<string, unknown>>)
      .filter((occurrence) => occurrence.layer === 1)
      .map(occurrenceIdentity);
    if (actual.length !== expected.size || new Set(actual).size !== actual.length || actual.some((identity) => !expected.has(identity))) {
      throw new Error(`Accepted checkpoint ${spec.batchId} does not exactly cover its token candidates.`);
    }
    for (const identity of Array.from(actual)) {
      if (acceptedOccurrenceIds.has(identity)) throw new Error(`Duplicate accepted occurrence ${identity}.`);
      acceptedOccurrenceIds.add(identity);
    }
    acceptedPrefix += 1;
  }
  if (!acceptedPrefix) throw new Error("The v2 plan requires a non-empty accepted annotation prefix.");
  const unexpected = Array.from(checkpointFiles).filter((fileName) =>
    !legacySpecs.slice(0, acceptedPrefix).some((spec) => fileName === `${spec.batchId}.json`)
  );
  if (unexpected.length) throw new Error(`Annotation checkpoints are not a contiguous legacy prefix: ${unexpected.join(", ")}.`);

  const plan: LexicalAgentBatchPlan = {
    version: LEXICAL_AGENT_BATCH_PLAN_V2,
    annotationAcceptedPrefixBatches: acceptedPrefix,
    acceptedAnnotationBatchIds: legacySpecs.slice(0, acceptedPrefix).map((spec) => spec.batchId),
    maxTokens: 80,
    maxBlocks: 6
  };
  const specs = buildLexicalAgentWorkBatchSpecs(works, "annotation", undefined, plan);
  const repeated = buildLexicalAgentWorkBatchSpecs(works, "annotation", undefined, plan);
  if (specs.some((spec, index) => spec.batchId !== repeated[index]?.batchId)) {
    throw new Error("The v2 pending plan is not deterministic.");
  }
  const pendingOccurrenceIds = specs.slice(acceptedPrefix).flatMap((spec) =>
    spec.works!.flatMap((work) => work.tokens.filter((token) => !token.excluded).map(tokenIdentity))
  );
  const pendingSet = new Set(pendingOccurrenceIds);
  if (pendingSet.size !== pendingOccurrenceIds.length) throw new Error("The v2 pending plan contains duplicate occurrences.");
  if (Array.from(pendingSet).some((identity) => acceptedOccurrenceIds.has(identity))) {
    throw new Error("Accepted and v2 pending occurrences overlap.");
  }
  const allEligible = new Set(works.flatMap((work) =>
    work.tokens.filter((token) => !token.excluded).map(tokenIdentity)
  ));
  if (acceptedOccurrenceIds.size + pendingSet.size !== allEligible.size) {
    throw new Error("Accepted and v2 pending occurrences do not cover the full annotation workload.");
  }
  const pendingBlocks = specs.slice(acceptedPrefix).flatMap((spec) => spec.works!);
  const pendingBlockKeys = pendingBlocks.map((work) =>
    `${work.block.sourceType}:${work.block.sourceItemId}:${work.block.contentBlockId}`
  );
  if (new Set(pendingBlockKeys).size !== pendingBlockKeys.length) throw new Error("The v2 pending plan duplicates a canonical block.");

  await writeJsonAtomic(paths.batchPlan, {
    protocol_version: LEXICAL_AGENT_PROTOCOL_VERSION,
    plan_version: plan.version,
    annotation_accepted_prefix_batches: acceptedPrefix,
    accepted_annotation_batch_ids: plan.acceptedAnnotationBatchIds,
    max_tokens: plan.maxTokens,
    max_blocks: plan.maxBlocks,
    original_total_batches: legacySpecs.length,
    planned_total_batches: specs.length,
    planned_pending_batches: specs.length - acceptedPrefix,
    accepted_occurrences: acceptedOccurrenceIds.size,
    pending_occurrences: pendingSet.size,
    full_occurrences: allEligible.size
  });

  const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as Record<string, unknown>;
  manifest.agent_batch_plan_version = plan.version;
  manifest.original_annotation_batches = legacySpecs.length;
  manifest.planned_annotation_batches = specs.length;
  manifest.agent_progress = {
    stage: "annotation",
    active_batch_id: null,
    completed_batches: acceptedPrefix,
    pending_batches: specs.length - acceptedPrefix,
    next_batch_index: acceptedPrefix,
    source_type: specs[acceptedPrefix]?.sourceType ?? null
  };
  manifest.updated_at = new Date().toISOString();
  await writeJsonAtomic(paths.manifest, manifest);
  console.log(JSON.stringify({
    plan_version: plan.version,
    accepted_batches_preserved: acceptedPrefix,
    original_total_batches: legacySpecs.length,
    planned_total_batches: specs.length,
    planned_pending_batches: specs.length - acceptedPrefix,
    accepted_occurrences: acceptedOccurrenceIds.size,
    pending_occurrences: pendingSet.size,
    full_occurrences: allEligible.size
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
