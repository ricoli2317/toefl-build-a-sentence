import { createHash } from "node:crypto";
import { LEXICAL_GENERATION_VERSION, type LexicalBlockWork } from "../generationTypes.ts";
import { lexicalSemanticProvenanceMatches } from "../provenance.ts";
import { LEXICAL_AGENT_ANNOTATION_SCHEMA_VERSION, LEXICAL_AGENT_PROTOCOL_VERSION } from "../agentProtocol.ts";

export const INCREMENTAL_AGENT_SCHEMA_ANNOTATION = LEXICAL_AGENT_ANNOTATION_SCHEMA_VERSION;

export type IncrementalAgentProvenance = {
  semantic_engine: "openchamber_agent";
  provider: "openai";
  model: string;
  thinking_effort: "high";
};

/** The incremental sync uses the current OpenChamber agent engine; the frozen validators stay unchanged. */
export function incrementalAgentProvenance(
  env: Partial<NodeJS.ProcessEnv> = process.env
): IncrementalAgentProvenance {
  return {
    semantic_engine: "openchamber_agent",
    provider: "openai",
    model: env.LEXICAL_INCREMENTAL_AGENT_MODEL?.trim() || "gpt-6.1-sol",
    thinking_effort: "high"
  };
}

export function incrementalInputSignature(stage: string, works: LexicalBlockWork[], provenance: IncrementalAgentProvenance) {
  return createHash("sha256").update(JSON.stringify({
    protocol: LEXICAL_AGENT_PROTOCOL_VERSION,
    stage,
    provenance,
    blocks: works.map(workInputIdentity)
  }), "utf8").digest("hex");
}

export function workInputIdentity(work: LexicalBlockWork) {
  return {
    generation_version: LEXICAL_GENERATION_VERSION,
    source_type: work.block.sourceType,
    source_item_id: work.block.sourceItemId,
    content_block_id: work.block.contentBlockId,
    block_kind: work.block.blockKind,
    source_text_hash: work.sourceTextHash,
    text: work.block.text,
    eligible_tokens: work.tokens.filter((token) => !token.excluded).map((token) => ({
      candidate_id: token.candidateId,
      surface_text: token.surfaceText,
      start_offset: token.startOffset,
      end_offset: token.endOffset,
      source_anchor_id: token.sourceAnchorId,
      sentence_id: token.sentenceId,
      source_review_reason: token.sourceReviewReason
    })),
    excluded_spans: work.tokens.filter((token) => token.excluded).map((token) => ({
      surface_text: token.surfaceText,
      start_offset: token.startOffset,
      end_offset: token.endOffset,
      exclusion_reason: token.exclusionReason
    }))
  };
}

/** Mirrors the frozen annotation stage batching: same source type, bounded blocks and eligible tokens. */
export function batchIncrementalWorks(works: LexicalBlockWork[], maxTokens: number, maxBlocks: number) {
  const batches: LexicalBlockWork[][] = [];
  let current: LexicalBlockWork[] = [];
  let tokenCount = 0;
  for (const work of works) {
    const workTokens = work.tokens.filter((token) => !token.excluded).length;
    if (current.length && (current.length >= maxBlocks || tokenCount + workTokens > maxTokens)) {
      batches.push(current);
      current = [];
      tokenCount = 0;
    }
    current.push(work);
    tokenCount += workTokens;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function annotationStageInput(works: LexicalBlockWork[], batchId: string, inputSignature: string, provenance: IncrementalAgentProvenance) {
  return {
    protocol_version: LEXICAL_AGENT_PROTOCOL_VERSION,
    batch_id: batchId,
    stage: "annotation",
    provenance,
    generation_version: LEXICAL_GENERATION_VERSION,
    schema_version: LEXICAL_AGENT_ANNOTATION_SCHEMA_VERSION,
    input_signature: inputSignature,
    source_type: works[0]?.block.sourceType ?? null,
    blocks: works.map(workInputIdentity),
    instruction: "Layer 1 only: return every block_key with tokens[] and expressions[]. Annotate every eligible token exactly once. expressions stay empty in this stage."
  };
}

export type IncrementalEnvelope = {
  protocol_version: string;
  stage: string;
  batch_id: string;
  generation_version: string;
  provenance: unknown;
  input_signature: string;
  schema_version?: string;
};

export function assertIncrementalEnvelope(
  output: unknown,
  expected: { stage: string; batchId: string; inputSignature: string; schemaVersion: string; provenance: IncrementalAgentProvenance }
) {
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("Agent output must be an object.");
  const record = output as Record<string, unknown>;
  const required = ["protocol_version", "stage", "batch_id", "generation_version", "provenance", "input_signature"];
  const allowed = new Set([...required, "schema_version", "blocks", "records"]);
  for (const field of required) {
    if (!(field in record)) throw new Error(`Agent output is missing ${field}.`);
  }
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) throw new Error(`Agent output contains unexpected field ${field}.`);
  }
  if (record.protocol_version !== LEXICAL_AGENT_PROTOCOL_VERSION || record.stage !== expected.stage
    || record.batch_id !== expected.batchId || record.generation_version !== LEXICAL_GENERATION_VERSION
    || record.input_signature !== expected.inputSignature) {
    throw new Error(`Agent output envelope mismatch for ${expected.batchId}.`);
  }
  if (record.schema_version !== undefined && record.schema_version !== expected.schemaVersion) {
    throw new Error(`Agent output schema_version mismatch for ${expected.batchId}.`);
  }
  if (!lexicalSemanticProvenanceMatches(record.provenance, expected.provenance)
    || Object.keys(record.provenance as Record<string, unknown>).length !== Object.keys(expected.provenance).length) {
    throw new Error(`Agent output provenance mismatch for ${expected.batchId}.`);
  }
  return record;
}
