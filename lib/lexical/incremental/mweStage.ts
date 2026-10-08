import { sha256File } from "./artifacts.ts";
import { assertIncrementalEnvelope, incrementalAgentProvenance, workInputIdentity, type IncrementalAgentProvenance } from "./envelope.ts";
import { assertStageComplete, incrementalBatchId, initStage, loadStage, readStageCheckpoint, readStageWork, type StageBatchInput } from "./stageRunner.ts";
import { stagePaths } from "./paths.ts";
import type { IncrementalAnnotationCheckpoint } from "./annotationStage.ts";
import { validateAnnotationBatch } from "../annotation.ts";
import { LEXICAL_AGENT_MWE_SCHEMA_VERSION, tokenAnnotationsFromOccurrences } from "../agentProtocol.ts";
import { LEXICAL_GENERATION_VERSION, type LexicalBlockWork, type LexicalOccurrenceArtifact } from "../generationTypes.ts";
import { createHash } from "node:crypto";

export type IncrementalMweWork = {
  annotation_batch_id: string;
  annotation_sha256: string;
  works: LexicalBlockWork[];
};

export type IncrementalMweCheckpoint = {
  protocol_version: string;
  batch_id: string;
  stage: "mwe";
  generation_version: typeof LEXICAL_GENERATION_VERSION;
  provenance: IncrementalAgentProvenance;
  input_signature: string;
  annotation_batch_id: string;
  annotation_sha256: string;
  mwe_detection_executed: true;
  occurrences: LexicalOccurrenceArtifact[];
};

export function mweInputSignature(work: IncrementalMweWork, provenance: IncrementalAgentProvenance) {
  return createHash("sha256").update(JSON.stringify({
    protocol: "lexical-agent-v1",
    stage: "mwe",
    provenance,
    annotation_batch_id: work.annotation_batch_id,
    annotation_sha256: work.annotation_sha256,
    blocks: work.works.map(workInputIdentity)
  }), "utf8").digest("hex");
}

async function assertAnnotationStageComplete(root: string) {
  await assertStageComplete(root, "annotation");
  const { plan, accepted } = await loadStage(root, "annotation");
  if (accepted.size !== plan.batches.length) {
    throw new Error(`Incremental annotation stage is not complete (${accepted.size}/${plan.batches.length}).`);
  }
  return { plan, accepted };
}

export async function buildMweStage(root: string, deltaPlanSha256: string) {
  const { plan: annotationPlan } = await assertAnnotationStageComplete(root);
  const provenance = incrementalAgentProvenance();
  const batches: StageBatchInput[] = [];
  for (let index = 0; index < annotationPlan.batches.length; index += 1) {
    const annotationBatch = annotationPlan.batches[index];
    const works = await readStageWork<LexicalBlockWork[]>(root, "annotation", annotationBatch.batch_id);
    const annotationSha = await sha256File(stageCheckpointPath(root, annotationBatch.batch_id));
    const work: IncrementalMweWork = {
      annotation_batch_id: annotationBatch.batch_id,
      annotation_sha256: annotationSha,
      works
    };
    const inputSignature = mweInputSignature(work, provenance);
    const batchId = incrementalBatchId("mwe", index, inputSignature);
    batches.push({
      sourceType: annotationBatch.source_type,
      inputSignature,
      blockKeys: annotationBatch.block_keys,
      input: {
        protocol_version: "lexical-agent-v1",
        batch_id: batchId,
        stage: "mwe",
        provenance,
        generation_version: LEXICAL_GENERATION_VERSION,
        schema_version: LEXICAL_AGENT_MWE_SCHEMA_VERSION,
        input_signature: inputSignature,
        annotation_batch_id: annotationBatch.batch_id,
        annotation_sha256: annotationSha,
        source_type: annotationBatch.source_type,
        blocks: works.map(workInputIdentity),
        instruction: "Layer 2 only: return every block_key with expressions[], never tokens. Include only independently learnable fixed expressions, collocations, academic/writing patterns, phrasal verbs, idioms and multiword proper names; no ordinary compositional phrases. Use exact UTF-16 source slices."
      },
      work
    });
  }
  return await initStage(root, "mwe", { sourcePlanSha256: deltaPlanSha256, provenance, batches });
}

function stageCheckpointPath(root: string, batchId: string) {
  return stagePaths(root, "annotation").checkpointPath(batchId);
}

export async function validateMweStageOutput(
  root: string,
  batchId: string,
  batch: { input_signature: string },
  output: unknown
): Promise<IncrementalMweCheckpoint> {
  const { plan: mwePlan } = await loadStage(root, "mwe");
  const work = await readStageWork<IncrementalMweWork>(root, "mwe", batchId);
  const record = assertIncrementalEnvelope(output, {
    stage: "mwe",
    batchId,
    inputSignature: batch.input_signature,
    schemaVersion: LEXICAL_AGENT_MWE_SCHEMA_VERSION,
    provenance: mwePlan.provenance
  });
  const annotationCheckpoint = await readStageCheckpoint<IncrementalAnnotationCheckpoint>(root, "annotation", work.annotation_batch_id);
  if (!annotationCheckpoint?.occurrences) throw new Error(`Missing annotation checkpoint ${work.annotation_batch_id}.`);
  if (await sha256File(stageCheckpointPath(root, work.annotation_batch_id)) !== work.annotation_sha256) {
    throw new Error("Frozen annotation checkpoint changed before MWE accept.");
  }
  if (!Array.isArray(record.blocks)) throw new Error("MWE output blocks must be an array.");
  const blocks = record.blocks as Array<Record<string, unknown>>;
  const expectedKeys = work.works.map((item) =>
    `${item.block.sourceType}:${item.block.sourceItemId}:${item.block.contentBlockId}`);
  const keys = blocks.map((block) => block?.block_key);
  if (keys.length !== expectedKeys.length || new Set(keys).size !== keys.length
    || keys.some((key) => !expectedKeys.includes(key as string))
    || blocks.some((block) => !block || typeof block !== "object" || Array.isArray(block)
      || Object.keys(block).length !== 2 || !Array.isArray(block.expressions)
      || Object.keys(block).some((key) => !["block_key", "expressions"].includes(key)))) {
    throw new Error("MWE blocks incomplete, duplicated, unknown, or contain tokens.");
  }
  const tokenBlocks = tokenAnnotationsFromOccurrences(work.works, annotationCheckpoint.occurrences);
  const expressionsByKey = new Map(blocks.map((block) => [block.block_key, block.expressions]));
  const combined = tokenBlocks.map((block) => ({ ...block, expressions: expressionsByKey.get(block.block_key) ?? [] }));
  const occurrences = validateAnnotationBatch(work.works, { blocks: combined });
  const layer1 = occurrences.filter((occurrence) => occurrence.layer === 1);
  if (JSON.stringify(layer1) !== JSON.stringify(annotationCheckpoint.occurrences)) {
    throw new Error("Layer-1 annotation mutation detected in the MWE stage.");
  }
  return {
    protocol_version: record.protocol_version as string,
    batch_id: batchId,
    stage: "mwe",
    generation_version: LEXICAL_GENERATION_VERSION,
    provenance: mwePlan.provenance,
    input_signature: batch.input_signature,
    annotation_batch_id: work.annotation_batch_id,
    annotation_sha256: work.annotation_sha256,
    mwe_detection_executed: true,
    occurrences
  };
}
