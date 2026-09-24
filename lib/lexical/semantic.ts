import { lexicalEntryKey, type LexicalExpressionType, type LexicalPos } from "./generationTypes.ts";
import { normalizeLexicalExpression } from "./normalize.ts";

const HAN_PATTERN = /[\u3400-\u9fff]/;
const PLACEHOLDER_PATTERN = /(?:待人工确认|requires review)/i;
const FUNCTION_WORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "if", "in", "into", "of", "on", "or",
  "that", "the", "to", "with", "which", "who", "whom", "whose"
]);

export type LexicalSemanticFields = {
  context_pos: LexicalPos;
  context_meaning_zh: string;
  context_definition_en: string;
  expression_type: LexicalExpressionType;
  canonical_expression?: string;
  lemma?: string;
  context_text?: string;
};

function comparisonText(value: string) {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9' -]+/g, " ").replace(/\s+/g, " ").trim();
}

function isCircularDefinition(canonicalExpression: string, definition: string) {
  const canonical = comparisonText(canonicalExpression);
  const normalizedDefinition = comparisonText(definition);
  return normalizedDefinition === canonical ||
    normalizedDefinition === `a ${canonical}` ||
    normalizedDefinition === `an ${canonical}` ||
    normalizedDefinition === `the ${canonical}`;
}

function isObviousInflection(baseExpression: string, candidateExpression: string) {
  const base = comparisonText(baseExpression);
  const candidate = comparisonText(candidateExpression);
  if (!base || !candidate || base.includes(" ") || candidate.includes(" ")) return false;
  const variants = new Set([
    `${base}s`, `${base}es`, `${base}ed`, `${base}d`, `${base}ing`
  ]);
  if (base.endsWith("e")) variants.add(`${base.slice(0, -1)}ing`);
  if (base.endsWith("y") && base.length > 1) {
    variants.add(`${base.slice(0, -1)}ies`);
    variants.add(`${base.slice(0, -1)}ied`);
  }
  const last = base.charAt(base.length - 1);
  if (last && /[b-df-hj-np-tv-z]/.test(last)) {
    variants.add(`${base}${last}ed`);
    variants.add(`${base}${last}ing`);
  }
  return variants.has(candidate);
}

export function lexicalSemanticIssues(fields: LexicalSemanticFields) {
  const issues: string[] = [];
  if (!HAN_PATTERN.test(fields.context_meaning_zh)) issues.push("meaning_zh_missing_chinese");
  if (HAN_PATTERN.test(fields.context_definition_en)) issues.push("definition_en_contains_chinese");
  if (
    PLACEHOLDER_PATTERN.test(fields.context_meaning_zh) ||
    PLACEHOLDER_PATTERN.test(fields.context_definition_en)
  ) issues.push("placeholder_semantics");
  const chineseCharacters = fields.context_meaning_zh.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  if (
    chineseCharacters > 48 ||
    (fields.context_text && chineseCharacters > 24 && fields.context_meaning_zh.length >= fields.context_text.trim().length * 0.75)
  ) issues.push("meaning_zh_likely_full_translation");
  if (fields.canonical_expression && isCircularDefinition(fields.canonical_expression, fields.context_definition_en)) {
    issues.push("circular_definition");
  }
  if (
    fields.canonical_expression &&
    fields.lemma &&
    normalizeLexicalExpression(fields.canonical_expression, fields.expression_type) !==
      normalizeLexicalExpression(fields.lemma, fields.expression_type)
  ) issues.push("canonical_lemma_identity_mismatch");
  if ((fields.expression_type === "proper_noun") !== (fields.context_pos === "proper_noun")) {
    issues.push("proper_noun_pos_type_mismatch");
  }
  return issues;
}

export function entrySenseSemanticIssues(
  expressionType: LexicalExpressionType,
  sense: { pos: LexicalPos; definition_en: string; meaning_zh: string },
  canonicalExpression?: string
) {
  return lexicalSemanticIssues({
    context_pos: sense.pos,
    context_meaning_zh: sense.meaning_zh,
    context_definition_en: sense.definition_en,
    expression_type: expressionType,
    canonical_expression: canonicalExpression
  });
}

export function lexicalEntryContentIssues(entry: {
  canonical_expression: string;
  normalized_expression: string;
  expression_type: LexicalExpressionType;
  lemma: string;
  entry_key?: string;
  common_senses: Array<{ pos: LexicalPos; definition_en: string; meaning_zh: string }>;
  derived_words: Array<{ expression: string }>;
  useful_patterns: Array<{ pattern: string }>;
}) {
  const issues: string[] = [];
  if (normalizeLexicalExpression(entry.canonical_expression, entry.expression_type) !== entry.normalized_expression) {
    issues.push("canonical_identity_mismatch");
  }
  if (normalizeLexicalExpression(entry.lemma, entry.expression_type) !== entry.normalized_expression) {
    issues.push("lemma_identity_mismatch");
  }
  if (entry.entry_key && entry.entry_key !== lexicalEntryKey(entry.normalized_expression, entry.expression_type)) {
    issues.push("entry_key_identity_mismatch");
  }
  if (entry.common_senses.length < 1 || entry.common_senses.length > 4) issues.push("common_sense_count");
  const senses = entry.common_senses.map((sense) => `${sense.pos}\u0000${sense.definition_en}\u0000${sense.meaning_zh}`);
  if (new Set(senses).size !== senses.length) issues.push("duplicate_senses");
  for (const sense of entry.common_senses) {
    issues.push(...entrySenseSemanticIssues(entry.expression_type, sense, entry.canonical_expression));
  }
  const derived = entry.derived_words.map((value) => value.expression.toLocaleLowerCase("en-US"));
  if (new Set(derived).size !== derived.length) issues.push("duplicate_derived_words");
  if (derived.includes(entry.canonical_expression.toLocaleLowerCase("en-US"))) issues.push("self_derived_word");
  if (entry.derived_words.some((value) => isObviousInflection(entry.canonical_expression, value.expression))) {
    issues.push("inflection_in_derived_words");
  }
  if (FUNCTION_WORDS.has(entry.normalized_expression) && entry.derived_words.length) {
    issues.push("function_word_derived_words");
  }
  const patterns = entry.useful_patterns.map((value) => value.pattern.toLocaleLowerCase("en-US"));
  if (new Set(patterns).size !== patterns.length) issues.push("duplicate_useful_patterns");
  if (entry.derived_words.length > 12) issues.push("derived_words_count_anomaly");
  if (entry.useful_patterns.length > 8) issues.push("useful_patterns_count_anomaly");
  return issues;
}

export function annotationOccurrencesNeedRecovery(
  occurrences: Array<Partial<LexicalSemanticFields> & { review_notes?: string | null }>
) {
  return occurrences.some((occurrence) => {
    if (
      occurrence.review_notes?.includes("model_schema_failure") ||
      occurrence.review_notes?.includes("mwe_model_failure")
    ) return true;
    if (
      occurrence.context_pos &&
      occurrence.context_meaning_zh &&
      occurrence.context_definition_en &&
      occurrence.expression_type
    ) return lexicalSemanticIssues(occurrence as LexicalSemanticFields).length > 0;
    return false;
  });
}

export function annotationCacheNeedsRecovery(cache: {
  recovered_by_lexeme?: unknown;
  occurrences?: Array<Partial<LexicalSemanticFields> & { review_notes?: string | null }>;
}) {
  return cache.recovered_by_lexeme === true ||
    (Array.isArray(cache.occurrences) && annotationOccurrencesNeedRecovery(cache.occurrences));
}
