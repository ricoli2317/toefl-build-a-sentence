import { validateAnnotationBatch } from "../annotation.ts";
import { LEXICAL_GENERATION_VERSION, type LexicalBlockWork, type LexicalOccurrenceArtifact } from "../generationTypes.ts";
import type { CanonicalLexicalSourceType } from "../types.ts";
import {
  annotationStageInput,
  assertIncrementalEnvelope,
  batchIncrementalWorks,
  incrementalAgentProvenance,
  incrementalInputSignature,
  INCREMENTAL_AGENT_SCHEMA_ANNOTATION,
  type IncrementalAgentProvenance
} from "./envelope.ts";
import { incrementalBatchId, initStage, loadStage, readStageWork, type StageBatchInput } from "./stageRunner.ts";

const SOURCE_TYPE_ORDER: CanonicalLexicalSourceType[] = [
  "ctw", "rdl", "rap", "bas", "write_email", "academic_discussion"
];

export function annotationBatchLimits() {
  return {
    maxTokens: Number(process.env.INCREMENTAL_ANNOTATION_BATCH_TOKENS ?? 80),
    maxBlocks: Number(process.env.INCREMENTAL_ANNOTATION_BATCH_BLOCKS ?? 6)
  };
}

export function planAnnotationBatches(works: LexicalBlockWork[]) {
  const { maxTokens, maxBlocks } = annotationBatchLimits();
  return SOURCE_TYPE_ORDER.flatMap((sourceType) =>
    batchIncrementalWorks(works.filter((work) => work.block.sourceType === sourceType), maxTokens, maxBlocks));
}

export async function buildAnnotationStage(root: string, works: LexicalBlockWork[], deltaPlanSha256: string) {
  const provenance = incrementalAgentProvenance();
  const batches = planAnnotationBatches(works);
  const inputs: StageBatchInput[] = batches.map((batchWorks, index) => {
    const inputSignature = incrementalInputSignature("annotation", batchWorks, provenance);
    const batchId = incrementalBatchId("annotation", index, inputSignature);
    return {
      sourceType: batchWorks[0]?.block.sourceType ?? "ctw",
      inputSignature,
      blockKeys: batchWorks.map((work) => `${work.block.sourceType}:${work.block.sourceItemId}:${work.block.contentBlockId}`),
      input: { ...annotationStageInput(batchWorks, batchId, inputSignature, provenance) },
      work: batchWorks
    };
  });
  return await initStage(root, "annotation", { sourcePlanSha256: deltaPlanSha256, provenance, batches: inputs });
}

export type IncrementalAnnotationCheckpoint = {
  protocol_version: string;
  batch_id: string;
  stage: "annotation";
  generation_version: typeof LEXICAL_GENERATION_VERSION;
  provenance: IncrementalAgentProvenance;
  input_signature: string;
  occurrences: LexicalOccurrenceArtifact[];
};

export async function validateAnnotationStageOutput(
  root: string,
  batchId: string,
  batch: { input_signature: string },
  output: unknown
): Promise<IncrementalAnnotationCheckpoint> {
  const { plan } = await loadStage(root, "annotation");
  const works = await readStageWork<LexicalBlockWork[]>(root, "annotation", batchId);
  const record = assertIncrementalEnvelope(output, {
    stage: "annotation",
    batchId,
    inputSignature: batch.input_signature,
    schemaVersion: INCREMENTAL_AGENT_SCHEMA_ANNOTATION,
    provenance: plan.provenance
  });
  // Layer 2 belongs to the separate MWE stage, never silently discard supplied expressions.
  if (Array.isArray(record.blocks) && record.blocks.some(block => {
    const expressions = (block as Record<string, unknown>)?.expressions;
    return expressions !== undefined && (!Array.isArray(expressions) || expressions.length !== 0);
  })) throw new Error("Annotation stage may not emit expressions.");
  const blocks = Array.isArray(record.blocks)
    ? (record.blocks as Array<Record<string, unknown>>).map((block) => ({ ...block, expressions: [] }))
    : record.blocks;
  const occurrences = validateAnnotationBatch(works, { blocks });
  if (occurrences.some((occurrence) => occurrence.layer !== 1)) {
    throw new Error("Incremental annotation stage must not emit Layer-2 expressions; MWE is a separate stage.");
  }
  return {
    protocol_version: record.protocol_version as string,
    batch_id: batchId,
    stage: "annotation",
    generation_version: LEXICAL_GENERATION_VERSION,
    provenance: plan.provenance,
    input_signature: batch.input_signature,
    occurrences
  };
}
