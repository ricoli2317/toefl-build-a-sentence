import { createHash } from "node:crypto";
import { LEXICAL_POS_VALUES, LEXICAL_GENERATION_VERSION, type LexicalOccurrenceArtifact } from "../generationTypes.ts";
import { readRequiredJson } from "./artifacts.ts";
import { assertIncrementalEnvelope, incrementalAgentProvenance, type IncrementalAgentProvenance } from "./envelope.ts";
import { incrementalBatchId, initStage, loadStage, readStageCheckpoint, readStageWork, type StageBatchInput } from "./stageRunner.ts";
import { assertStageComplete } from "./stageRunner.ts";
import type { IncrementalMweCheckpoint, IncrementalMweWork } from "./mweStage.ts";
import { validateAnnotationBatch } from "../annotation.ts";
import { tokenAnnotationsFromOccurrences } from "../agentProtocol.ts";
import { normalizeLexicalExpression } from "../normalize.ts";
import { lexicalEntryKey } from "../generationTypes.ts";
import { stagePaths } from "./paths.ts";
import type { IncrementalAnnotationCheckpoint } from "./annotationStage.ts";

export const INCREMENTAL_MWE_QA_SCHEMA_VERSION = "lexical-mwe-expression-qa-v1";
export const MWE_QA_ISSUE_TYPES = ["over_collected", "wrong_expression_type", "wrong_learning_value", "wrong_pos",
  "wrong_canonical_expression", "wrong_lemma", "wrong_meaning_zh", "wrong_definition_en"] as const;
const MWE_TYPES = ["phrase", "phrasal_verb", "idiom", "proper_noun"];
const MWE_VALUES = ["fixed_expression", "common_collocation", "academic_expression", "writing_pattern", "phrasal_verb", "idiom", "proper_name"];
export const MWE_QA_CORRECTION_FIELDS = {
  expression_type: "wrong_expression_type",
  learning_value: "wrong_learning_value",
  context_pos: "wrong_pos",
  canonical_expression: "wrong_canonical_expression",
  lemma: "wrong_lemma",
  context_meaning_zh: "wrong_meaning_zh",
  context_definition_en: "wrong_definition_en"
} as const;
export type MweQaCorrectionField = keyof typeof MWE_QA_CORRECTION_FIELDS;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const identityFields = (o: Record<string, unknown>) => ({
  source_type: o.source_type,
  source_item_id: o.source_item_id,
  content_block_id: o.content_block_id,
  start_offset: o.start_offset,
  end_offset: o.end_offset,
  surface_text: o.surface_text
});

export type IncrementalQaIdentity = {
  occurrence_id: string;
  source_type: string;
  source_item_id: string;
  content_block_id: string;
  start_offset: number;
  end_offset: number;
  surface_text: string;
};

export function mweQaExpressionIdentity(value: Record<string, unknown>): IncrementalQaIdentity {
  const fields = identityFields(value);
  return { occurrence_id: `mwe-occ-${sha256(JSON.stringify(Object.values(fields)))}`, ...fields } as IncrementalQaIdentity;
}

export type IncrementalQaExpression = {
  expression_identity: IncrementalQaIdentity;
  canonical_block_text: string;
  surface_text: string;
  start_offset: number;
  end_offset: number;
  expression_type: string;
  learning_value: string;
  context_pos: string;
  context_meaning_zh: string;
  context_definition_en: string;
  canonical_expression: string;
  lemma: string;
};

export type IncrementalQaRecord = {
  expression_identity: IncrementalQaIdentity;
  verdict: "PASS" | "ISSUE";
  issue_types?: string[];
  concise_reason?: string;
  recommended_action?: "remove" | "correct";
  corrections?: Partial<Record<MweQaCorrectionField, string>>;
};

export type IncrementalMweQaCheckpoint = {
  protocol_version: string;
  batch_id: string;
  stage: "mwe-qa";
  generation_version: typeof LEXICAL_GENERATION_VERSION;
  provenance: IncrementalAgentProvenance;
  input_signature: string;
  records: IncrementalQaRecord[];
};

/** Keeps complete blocks together; mirrors the frozen MWE QA packing targets (50-80 expressions). */
export function packMweQaExpressions(expressions: IncrementalQaExpression[], maxPerBatch = 64, minPerBatch = 50) {
  const blockKeyOf = (expression: IncrementalQaExpression) =>
    `${expression.expression_identity.source_type}:${expression.expression_identity.source_item_id}:${expression.expression_identity.content_block_id}`;
  const sorted = [...expressions].sort((left, right) =>
    blockKeyOf(left).localeCompare(blockKeyOf(right))
    || left.start_offset - right.start_offset
    || left.end_offset - right.end_offset);
  const groups: IncrementalQaExpression[][] = [];
  for (const expression of sorted) {
    const previous = groups.at(-1);
    if (previous && previous.length < 80 && blockKeyOf(previous[0]) === blockKeyOf(expression)) previous.push(expression);
    else groups.push([expression]);
  }
  const batches: IncrementalQaExpression[][] = [];
  let current: IncrementalQaExpression[] = [];
  for (const group of groups) {
    if (current.length && current.length + group.length > maxPerBatch) {
      batches.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length) batches.push(current);
  // Rebalance a short tail into the previous batch when that keeps the size bound.
  if (batches.length > 1 && batches.at(-1)!.length < minPerBatch) {
    const tail = batches.at(-1)!;
    const previous = batches[batches.length - 2];
    if (previous.length + tail.length <= 80) {
      batches.splice(-2, 2, [...previous, ...tail]);
    }
  }
  return batches;
}

export async function buildMweQaStage(root: string, deltaPlanSha256: string) {
  await assertStageComplete(root, "mwe");
  const provenance = incrementalAgentProvenance();
  const { plan: mwePlan, paths: mwePaths } = await loadStage(root, "mwe");
  const expressions: IncrementalQaExpression[] = [];
  for (const batch of mwePlan.batches) {
    const checkpoint = await readStageCheckpoint<IncrementalMweCheckpoint>(root, "mwe", batch.batch_id);
    if (!checkpoint?.occurrences) throw new Error(`Missing MWE checkpoint ${batch.batch_id}.`);
    const work = await readStageWork<IncrementalMweWork>(root, "mwe", batch.batch_id);
    const blockText = new Map<string, string>(work.works.map((item) =>
      [`${item.block.sourceType}:${item.block.sourceItemId}:${item.block.contentBlockId}`, item.block.text] as const));
    const output = await readRequiredJson<{ blocks: Array<{ block_key: string; expressions: Array<Record<string, any>> }> }>(
      mwePaths.outputPath(batch.batch_id));
    const learningBySpan = new Map<string, string>();
    for (const block of output.blocks) {
      for (const expression of block.expressions) {
        learningBySpan.set(JSON.stringify([block.block_key, expression.start_offset, expression.end_offset]), String(expression.learning_value));
      }
    }
    for (const occurrence of checkpoint.occurrences.filter((value) => value.layer === 2)) {
      const key = `${occurrence.source_type}:${occurrence.source_item_id}:${occurrence.content_block_id}`;
      const text = blockText.get(key);
      if (text === undefined || occurrence.context_text !== text
        || text.slice(occurrence.start_offset, occurrence.end_offset) !== occurrence.surface_text) {
        throw new Error(`MWE checkpoint ${batch.batch_id} has an invalid canonical occurrence slice.`);
      }
      const learningValue = learningBySpan.get(JSON.stringify([key, occurrence.start_offset, occurrence.end_offset]));
      if (!learningValue || !MWE_VALUES.includes(learningValue)) throw new Error(`Missing learning_value for MWE occurrence ${key}.`);
      expressions.push({
        expression_identity: mweQaExpressionIdentity(occurrence as unknown as Record<string, unknown>),
        canonical_block_text: text,
        surface_text: occurrence.surface_text,
        start_offset: occurrence.start_offset,
        end_offset: occurrence.end_offset,
        expression_type: occurrence.expression_type,
        learning_value: learningValue,
        context_pos: occurrence.context_pos,
        context_meaning_zh: occurrence.context_meaning_zh,
        context_definition_en: occurrence.context_definition_en,
        canonical_expression: occurrence.canonical_expression,
        lemma: occurrence.lemma
      });
    }
  }
  const batches = packMweQaExpressions(expressions);
  const inputs: StageBatchInput[] = batches.map((batchExpressions, index) => {
    const signatureSource = JSON.stringify({
      protocol: "lexical-agent-v1",
      stage: "mwe-qa",
      provenance,
      identity_sha256: sha256(JSON.stringify(batchExpressions.map((expression) => expression.expression_identity.occurrence_id)))
    });
    const inputSignature = sha256(signatureSource);
    const batchId = incrementalBatchId("mwe-qa", index, inputSignature);
    return {
      sourceType: batchExpressions[0]?.expression_identity.source_type ?? "ctw",
      inputSignature,
      blockKeys: Array.from(new Set(batchExpressions.map((expression) =>
        `${expression.expression_identity.source_type}:${expression.expression_identity.source_item_id}:${expression.expression_identity.content_block_id}`))),
      input: {
        protocol_version: "lexical-agent-v1",
        batch_id: batchId,
        stage: "mwe-qa",
        provenance,
        generation_version: LEXICAL_GENERATION_VERSION,
        schema_version: INCREMENTAL_MWE_QA_SCHEMA_VERSION,
        input_signature: inputSignature,
        instruction: [
          "Judge every supplied Layer-2 expression once and return exactly one record per expression_identity.",
          "PASS means the expression is independently learnable and every field is correct.",
          "ISSUE requires issue_types and a concise_reason; over_collected expressions must use recommended_action remove.",
          "correct requires concrete corrections limited to expression_type, learning_value, context_pos, canonical_expression, lemma, context_meaning_zh, context_definition_en.",
          "Never mutate expression_identity, offsets or surface_text."
        ].join(" "),
        expressions: batchExpressions
      },
      work: batchExpressions
    };
  });
  return await initStage(root, "mwe-qa", { sourcePlanSha256: deltaPlanSha256, provenance, batches: inputs });
}

const object = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const fields = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export function validateIncrementalMweQaRecords(expressions: IncrementalQaExpression[], records: unknown): IncrementalQaRecord[] {
  if (!Array.isArray(records) || records.length !== expressions.length) throw new Error("Missing QA records/coverage mismatch.");
  const originals = new Map(expressions.map((expression) => [
    (expression.expression_identity as unknown as Record<string, string>).occurrence_id, expression]));
  const seen = new Set<string>();
  for (const record of records) {
    if (!object(record) || !object(record.expression_identity)) throw new Error("Invalid QA expression identity.");
    const id = record.expression_identity.occurrence_id;
    const original = originals.get(id);
    if (!original || seen.has(id)) throw new Error("Unknown or duplicate QA expression identity.");
    seen.add(id);
    if (!fields(record.expression_identity, Object.keys(original.expression_identity))
      || Object.keys(original.expression_identity).some((key) =>
        record.expression_identity[key] !== (original.expression_identity as unknown as Record<string, unknown>)[key])) {
      throw new Error("QA expression identity/offset/surface mutation forbidden.");
    }
    if (record.verdict === "PASS") {
      if (!fields(record, ["expression_identity", "verdict"])) throw new Error("PASS must contain only identity/verdict.");
    } else if (record.verdict === "ISSUE") {
      if (!Array.isArray(record.issue_types) || !record.issue_types.length || new Set(record.issue_types).size !== record.issue_types.length
        || record.issue_types.some((type: unknown) => !(MWE_QA_ISSUE_TYPES as readonly string[]).includes(type as string))
        || typeof record.concise_reason !== "string" || !record.concise_reason.trim()) {
        throw new Error("Invalid QA issue type/reason.");
      }
      const base = ["expression_identity", "verdict", "issue_types", "concise_reason", "recommended_action"];
      if (record.recommended_action === "remove") {
        if (!fields(record, base) || !record.issue_types.includes("over_collected")) {
          throw new Error("Remove requires explicit over_collected reason and no corrections.");
        }
      } else if (record.recommended_action === "correct") {
        if (!fields(record, [...base, "corrections"]) || !object(record.corrections) || !Object.keys(record.corrections).length
          || record.issue_types.includes("over_collected")) {
          throw new Error("Correct requires concrete correction fields; over_collected must remove.");
        }
        for (const [field, value] of Object.entries(record.corrections)) {
          if (!Object.hasOwn(MWE_QA_CORRECTION_FIELDS, field) || typeof value !== "string" || !value.trim()
            || value === (original as unknown as Record<string, unknown>)[field]
            || !record.issue_types.includes(MWE_QA_CORRECTION_FIELDS[field as MweQaCorrectionField])) {
            throw new Error("Invalid QA correction field/value.");
          }
          if ((field === "expression_type" && !MWE_TYPES.includes(value))
            || (field === "learning_value" && !MWE_VALUES.includes(value))
            || (field === "context_pos" && !(LEXICAL_POS_VALUES as readonly string[]).includes(value))) {
            throw new Error("Invalid QA correction enum.");
          }
        }
        if (record.issue_types.some((type: string) =>
          !Object.keys(record.corrections).some((field) => MWE_QA_CORRECTION_FIELDS[field as MweQaCorrectionField] === type))) {
          throw new Error("Each correction issue requires its corresponding field.");
        }
      } else {
        throw new Error("Invalid QA recommended_action.");
      }
    } else {
      throw new Error("Invalid QA verdict.");
    }
  }
  return expressions.map((expression) => records.find((record) =>
    record.expression_identity.occurrence_id === (expression.expression_identity as unknown as Record<string, string>).occurrence_id)!);
}

export async function validateMweQaStageOutput(
  root: string,
  batchId: string,
  batch: { input_signature: string },
  output: unknown
): Promise<IncrementalMweQaCheckpoint> {
  const { plan: qaPlan } = await loadStage(root, "mwe-qa");
  const expressions = await readStageWork<IncrementalQaExpression[]>(root, "mwe-qa", batchId);
  const record = assertIncrementalEnvelope(output, {
    stage: "mwe-qa",
    batchId,
    inputSignature: batch.input_signature,
    schemaVersion: INCREMENTAL_MWE_QA_SCHEMA_VERSION,
    provenance: qaPlan.provenance
  });
  const records = validateIncrementalMweQaRecords(expressions, record.records);
  // A whitelist is not a semantic validator. Replay the complete frozen annotation validator
  // over corrected expressions, using the unchanged Layer-1 token annotations and original work.
  const decisions = new Map(records.map(value => [value.expression_identity.occurrence_id, value]));
  const blockKeys = new Set(expressions.map(value => `${value.expression_identity.source_type}:${value.expression_identity.source_item_id}:${value.expression_identity.content_block_id}`));
  const { plan: mwePlan } = await loadStage(root, "mwe");
  for (const mweBatch of mwePlan.batches.filter(value => value.block_keys.some(key => blockKeys.has(key)))) {
    const work = await readStageWork<IncrementalMweWork>(root, "mwe", mweBatch.batch_id);
    const annotation = await readStageCheckpoint<IncrementalAnnotationCheckpoint>(root, "annotation", work.annotation_batch_id);
    if (!annotation) throw new Error("MWE QA lost its frozen annotation checkpoint.");
    const original = await readRequiredJson<{ blocks: Array<{ block_key: string; expressions: Array<Record<string, any>> }> }>(stagePaths(root, "mwe").outputPath(mweBatch.batch_id));
    const rawByKey = new Map(original.blocks.map(value => [value.block_key, value.expressions]));
    const blocks = tokenAnnotationsFromOccurrences(work.works, annotation.occurrences).map(block => {
      const source = work.works.find(value => `${value.block.sourceType}:${value.block.sourceItemId}:${value.block.contentBlockId}` === block.block_key)!.block;
      return { ...block, expressions: (rawByKey.get(block.block_key) ?? []).flatMap(expression => {
        const identity = mweQaExpressionIdentity({ ...expression, source_type: source.sourceType, source_item_id: source.sourceItemId, content_block_id: source.contentBlockId });
        const decision = decisions.get(identity.occurrence_id);
        if (decision?.recommended_action === "remove") return [];
        return [{ ...expression, ...(decision?.corrections ?? {}) }];
      }) };
    });
    const validated = validateAnnotationBatch(work.works, { blocks });
    if (JSON.stringify(validated.filter(value => value.layer === 1)) !== JSON.stringify(annotation.occurrences)) throw new Error("MWE QA mutated Layer-1 annotations.");
  }
  return {
    protocol_version: record.protocol_version as string,
    batch_id: batchId,
    stage: "mwe-qa",
    generation_version: LEXICAL_GENERATION_VERSION,
    provenance: qaPlan.provenance,
    input_signature: batch.input_signature,
    records
  };
}

/** Ported from the frozen MWE QA decision application: remove or field-only correction, never identity mutation. */
export function applyIncrementalMweQaDecision(
  occurrence: LexicalOccurrenceArtifact & Record<string, unknown>,
  record: IncrementalQaRecord
): (LexicalOccurrenceArtifact & Record<string, unknown>) | null {
  const identity = mweQaExpressionIdentity(occurrence as unknown as Record<string, unknown>);
  if (Object.entries(identity).some(([key, value]) => (record.expression_identity as unknown as Record<string, unknown>)[key] !== value)) {
    throw new Error("QA record identity does not match its occurrence.");
  }
  if (!record.recommended_action) return occurrence;
  if (record.recommended_action === "remove") return null;
  const corrected = { ...occurrence, ...(record.corrections ?? {}) } as unknown as LexicalOccurrenceArtifact & Record<string, unknown>;
  const normalizedExpression = normalizeLexicalExpression(corrected.canonical_expression, corrected.expression_type);
  return { ...corrected, normalized_expression: normalizedExpression,
    normalized_surface: normalizeLexicalExpression(corrected.surface_text, corrected.expression_type),
    entry_key: lexicalEntryKey(normalizedExpression, corrected.expression_type) };
}
