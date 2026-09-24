import {
  LEXICAL_GENERATION_VERSION,
  LEXICAL_POS_VALUES,
  lexicalEntryKey,
  type LexicalBlockWork,
  type LexicalExpressionType,
  type LexicalOccurrenceArtifact,
  type LexicalPos
} from "./generationTypes.ts";
import { normalizeLexicalExpression } from "./normalize.ts";
import { lexicalSemanticIssues } from "./semantic.ts";

const POS_VALUES = new Set<string>(LEXICAL_POS_VALUES);
const TOKEN_TYPES = new Set<string>(["word", "proper_noun"]);
const MWE_TYPES = new Set<string>(["phrase", "phrasal_verb", "idiom", "proper_noun"]);
const MWE_VALUES = new Set<string>([
  "fixed_expression",
  "common_collocation",
  "academic_expression",
  "writing_pattern",
  "phrasal_verb",
  "idiom",
  "proper_name"
]);

export const LEXICAL_ANNOTATION_SCHEMA_VERSION = "lexical-annotation-v1";

export const LEXICAL_ANNOTATION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["blocks"],
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["block_key", "tokens", "expressions"],
        properties: {
          block_key: { type: "string" },
          tokens: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "candidate_id",
                "context_pos",
                "context_meaning_zh",
                "context_definition_en",
                "canonical_expression",
                "lemma",
                "expression_type",
                "needs_review",
                "review_notes"
              ],
              properties: {
                candidate_id: { type: "string" },
                context_pos: { type: "string", enum: [...LEXICAL_POS_VALUES] },
                context_meaning_zh: { type: "string" },
                context_definition_en: { type: "string" },
                canonical_expression: { type: "string" },
                lemma: { type: "string" },
                expression_type: { type: "string", enum: ["word", "proper_noun"] },
                needs_review: { type: "boolean" },
                review_notes: { type: ["string", "null"] }
              }
            }
          },
          expressions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "start_offset",
                "end_offset",
                "surface_text",
                "context_pos",
                "context_meaning_zh",
                "context_definition_en",
                "canonical_expression",
                "lemma",
                "expression_type",
                "learning_value",
                "needs_review",
                "review_notes"
              ],
              properties: {
                start_offset: { type: "integer" },
                end_offset: { type: "integer" },
                surface_text: { type: "string" },
                context_pos: { type: "string", enum: [...LEXICAL_POS_VALUES] },
                context_meaning_zh: { type: "string" },
                context_definition_en: { type: "string" },
                canonical_expression: { type: "string" },
                lemma: { type: "string" },
                expression_type: { type: "string", enum: ["phrase", "phrasal_verb", "idiom", "proper_noun"] },
                learning_value: { type: "string", enum: Array.from(MWE_VALUES) },
                needs_review: { type: "boolean" },
                review_notes: { type: ["string", "null"] }
              }
            }
          }
        }
      }
    }
  }
} as const;

export class LexicalAnnotationValidationError extends Error {}

type ModelTokenAnnotation = {
  candidate_id: string;
  context_pos: LexicalPos;
  context_meaning_zh: string;
  context_definition_en: string;
  canonical_expression: string;
  lemma: string;
  expression_type: "word" | "proper_noun";
  needs_review: boolean;
  review_notes: string | null;
};

type ModelExpressionAnnotation = {
  start_offset: number;
  end_offset: number;
  surface_text: string;
  context_pos: LexicalPos;
  context_meaning_zh: string;
  context_definition_en: string;
  canonical_expression: string;
  lemma: string;
  expression_type: Exclude<LexicalExpressionType, "word">;
  learning_value: string;
  needs_review: boolean;
  review_notes: string | null;
};

export type ModelBlockAnnotation = {
  block_key: string;
  tokens: ModelTokenAnnotation[];
  expressions: ModelExpressionAnnotation[];
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LexicalAnnotationValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new LexicalAnnotationValidationError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function nullableString(value: unknown, label: string) {
  if (value === null) return null;
  if (typeof value !== "string") throw new LexicalAnnotationValidationError(`${label} must be a string or null.`);
  return value.trim() || null;
}

function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new LexicalAnnotationValidationError(`${label} must be boolean.`);
  return value;
}

function integer(value: unknown, label: string) {
  if (!Number.isInteger(value)) throw new LexicalAnnotationValidationError(`${label} must be an integer.`);
  return value as number;
}

function pos(value: unknown, label: string) {
  const parsed = nonEmptyString(value, label);
  if (!POS_VALUES.has(parsed)) throw new LexicalAnnotationValidationError(`${label} has unknown POS ${parsed}.`);
  return parsed as LexicalPos;
}

export function parseLexicalAnnotationPayload(value: unknown): ModelBlockAnnotation[] {
  const root = record(value, "annotation payload");
  if (!Array.isArray(root.blocks)) throw new LexicalAnnotationValidationError("annotation payload.blocks must be an array.");
  return root.blocks.map((blockValue, blockIndex) => {
    const block = record(blockValue, `blocks[${blockIndex}]`);
    if (!Array.isArray(block.tokens) || !Array.isArray(block.expressions)) {
      throw new LexicalAnnotationValidationError(`blocks[${blockIndex}] must contain token and expression arrays.`);
    }
    return {
      block_key: nonEmptyString(block.block_key, `blocks[${blockIndex}].block_key`),
      tokens: block.tokens.map((tokenValue, tokenIndex) => {
        const token = record(tokenValue, `blocks[${blockIndex}].tokens[${tokenIndex}]`);
        const expressionType = nonEmptyString(token.expression_type, "token.expression_type");
        if (!TOKEN_TYPES.has(expressionType)) throw new LexicalAnnotationValidationError(`Invalid token expression type ${expressionType}.`);
        const parsed = {
          candidate_id: nonEmptyString(token.candidate_id, "token.candidate_id"),
          context_pos: pos(token.context_pos, "token.context_pos"),
          context_meaning_zh: nonEmptyString(token.context_meaning_zh, "token.context_meaning_zh"),
          context_definition_en: nonEmptyString(token.context_definition_en, "token.context_definition_en"),
          canonical_expression: nonEmptyString(token.canonical_expression, "token.canonical_expression"),
          lemma: nonEmptyString(token.lemma, "token.lemma"),
          expression_type: expressionType as "word" | "proper_noun",
          needs_review: boolean(token.needs_review, "token.needs_review"),
          review_notes: nullableString(token.review_notes, "token.review_notes")
        };
        const semanticIssues = lexicalSemanticIssues(parsed);
        if (semanticIssues.length) {
          throw new LexicalAnnotationValidationError(`Token annotation failed semantic validation: ${semanticIssues.join(", ")}.`);
        }
        return parsed;
      }),
      expressions: block.expressions.map((expressionValue, expressionIndex) => {
        const expression = record(expressionValue, `blocks[${blockIndex}].expressions[${expressionIndex}]`);
        const expressionType = nonEmptyString(expression.expression_type, "expression.expression_type");
        const learningValue = nonEmptyString(expression.learning_value, "expression.learning_value");
        if (!MWE_TYPES.has(expressionType)) throw new LexicalAnnotationValidationError(`Invalid MWE type ${expressionType}.`);
        if (!MWE_VALUES.has(learningValue)) throw new LexicalAnnotationValidationError(`Invalid MWE learning value ${learningValue}.`);
        const parsed = {
          start_offset: integer(expression.start_offset, "expression.start_offset"),
          end_offset: integer(expression.end_offset, "expression.end_offset"),
          surface_text: nonEmptyString(expression.surface_text, "expression.surface_text"),
          context_pos: pos(expression.context_pos, "expression.context_pos"),
          context_meaning_zh: nonEmptyString(expression.context_meaning_zh, "expression.context_meaning_zh"),
          context_definition_en: nonEmptyString(expression.context_definition_en, "expression.context_definition_en"),
          canonical_expression: nonEmptyString(expression.canonical_expression, "expression.canonical_expression"),
          lemma: nonEmptyString(expression.lemma, "expression.lemma"),
          expression_type: expressionType as Exclude<LexicalExpressionType, "word">,
          learning_value: learningValue,
          needs_review: boolean(expression.needs_review, "expression.needs_review"),
          review_notes: nullableString(expression.review_notes, "expression.review_notes")
        };
        const semanticIssues = lexicalSemanticIssues(parsed);
        if (semanticIssues.length) {
          throw new LexicalAnnotationValidationError(`MWE annotation failed semantic validation: ${semanticIssues.join(", ")}.`);
        }
        return parsed;
      })
    };
  });
}

export function lexicalBlockKey(work: LexicalBlockWork) {
  const { block } = work;
  return `${block.sourceType}:${block.sourceItemId}:${block.contentBlockId}`;
}

function reviewNotes(...values: Array<string | null | undefined>) {
  const notes = Array.from(new Set(values.filter((value): value is string => Boolean(value?.trim()))));
  return notes.length ? notes.join("; ") : null;
}

export function validateAndMaterializeBlockAnnotation(
  work: LexicalBlockWork,
  annotation: ModelBlockAnnotation
): LexicalOccurrenceArtifact[] {
  const blockKey = lexicalBlockKey(work);
  if (annotation.block_key !== blockKey) {
    throw new LexicalAnnotationValidationError(`Annotation block key mismatch: expected ${blockKey}.`);
  }
  const eligibleTokens = work.tokens.filter((token) => !token.excluded);
  const tokenById = new Map(eligibleTokens.map((token) => [token.candidateId, token]));
  const annotationsById = new Map<string, ModelTokenAnnotation>();
  for (const token of annotation.tokens) {
    if (!tokenById.has(token.candidate_id) || annotationsById.has(token.candidate_id)) {
      throw new LexicalAnnotationValidationError(`Unknown or duplicate token annotation ${token.candidate_id}.`);
    }
    annotationsById.set(token.candidate_id, token);
  }
  const missing = eligibleTokens.filter((token) => !annotationsById.has(token.candidateId));
  if (missing.length) throw new LexicalAnnotationValidationError(`${blockKey} is missing ${missing.length} token annotations.`);

  const occurrences: LexicalOccurrenceArtifact[] = eligibleTokens.map((token) => {
    const model = annotationsById.get(token.candidateId)!;
    const normalizedExpression = normalizeLexicalExpression(model.canonical_expression, model.expression_type);
    const notes = reviewNotes(model.review_notes, token.sourceReviewReason);
    const needsReview = model.needs_review || token.sourceReviewReason !== null;
    return {
      entry_key: lexicalEntryKey(normalizedExpression, model.expression_type),
      source_type: token.sourceType,
      source_item_id: token.sourceItemId,
      content_block_id: token.contentBlockId,
      sentence_id: token.sentenceId,
      source_anchor_id: token.sourceAnchorId,
      surface_text: token.surfaceText,
      normalized_surface: token.normalizedSurface,
      start_offset: token.startOffset,
      end_offset: token.endOffset,
      context_pos: model.context_pos,
      context_meaning_zh: model.context_meaning_zh,
      context_definition_en: model.context_definition_en,
      context_text: work.block.text,
      review_status: needsReview ? "needs_review" : "generated",
      generation_version: LEXICAL_GENERATION_VERSION,
      review_notes: notes,
      layer: 1,
      expression_type: model.expression_type,
      canonical_expression: model.canonical_expression,
      normalized_expression: normalizedExpression,
      lemma: model.lemma
    };
  });

  for (const expression of annotation.expressions) {
    const { start_offset: startOffset, end_offset: endOffset } = expression;
    if (startOffset < 0 || endOffset <= startOffset || endOffset > work.block.text.length) {
      throw new LexicalAnnotationValidationError(`${blockKey} has an invalid MWE span.`);
    }
    if (work.block.text.slice(startOffset, endOffset) !== expression.surface_text) {
      throw new LexicalAnnotationValidationError(`${blockKey} MWE does not match its exact UTF-16 slice.`);
    }
    const coveredTokens = eligibleTokens.filter((token) => token.startOffset >= startOffset && token.endOffset <= endOffset);
    if (coveredTokens.length < 2 || coveredTokens[0].startOffset !== startOffset || coveredTokens[coveredTokens.length - 1].endOffset !== endOffset) {
      throw new LexicalAnnotationValidationError(`${blockKey} MWE must align to at least two eligible lexical tokens.`);
    }
    if (coveredTokens.some((token) => token.excluded)) {
      throw new LexicalAnnotationValidationError(`${blockKey} MWE overlaps an excluded person-name token.`);
    }
    const normalizedExpression = normalizeLexicalExpression(expression.canonical_expression, expression.expression_type);
    occurrences.push({
      entry_key: lexicalEntryKey(normalizedExpression, expression.expression_type),
      source_type: work.block.sourceType,
      source_item_id: work.block.sourceItemId,
      content_block_id: work.block.contentBlockId,
      sentence_id: coveredTokens.every((token) => token.sentenceId === coveredTokens[0].sentenceId)
        ? coveredTokens[0].sentenceId
        : null,
      source_anchor_id: null,
      surface_text: expression.surface_text,
      normalized_surface: normalizeLexicalExpression(expression.surface_text, expression.expression_type),
      start_offset: startOffset,
      end_offset: endOffset,
      context_pos: expression.context_pos,
      context_meaning_zh: expression.context_meaning_zh,
      context_definition_en: expression.context_definition_en,
      context_text: work.block.text,
      review_status: expression.needs_review ? "needs_review" : "generated",
      generation_version: LEXICAL_GENERATION_VERSION,
      review_notes: expression.review_notes,
      layer: 2,
      expression_type: expression.expression_type,
      canonical_expression: expression.canonical_expression,
      normalized_expression: normalizedExpression,
      lemma: expression.lemma
    });
  }

  const exactSpans = new Set<string>();
  for (const occurrence of occurrences) {
    const key = `${occurrence.start_offset}:${occurrence.end_offset}`;
    if (exactSpans.has(key)) throw new LexicalAnnotationValidationError(`${blockKey} has a duplicate exact occurrence span ${key}.`);
    exactSpans.add(key);
  }
  return occurrences;
}

export function validateAnnotationBatch(
  works: LexicalBlockWork[],
  payload: unknown
) {
  const annotations = parseLexicalAnnotationPayload(payload);
  const workByKey = new Map(works.map((work) => [lexicalBlockKey(work), work]));
  const annotationByKey = new Map<string, ModelBlockAnnotation>();
  for (const annotation of annotations) {
    if (!workByKey.has(annotation.block_key) || annotationByKey.has(annotation.block_key)) {
      throw new LexicalAnnotationValidationError(`Unknown or duplicate block annotation ${annotation.block_key}.`);
    }
    annotationByKey.set(annotation.block_key, annotation);
  }
  if (annotationByKey.size !== works.length) {
    throw new LexicalAnnotationValidationError(`Expected ${works.length} annotated blocks, received ${annotationByKey.size}.`);
  }
  return works.flatMap((work) => validateAndMaterializeBlockAnnotation(work, annotationByKey.get(lexicalBlockKey(work))!));
}
