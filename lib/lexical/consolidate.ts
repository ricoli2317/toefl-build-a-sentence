import {
  LEXICAL_GENERATION_VERSION,
  LEXICAL_POS_VALUES,
  type LexicalEntryArtifact,
  type LexicalOccurrenceArtifact,
  type LexicalPos,
  type LexicalReviewStatus
} from "./generationTypes.ts";
import { lexicalEntryContentIssues } from "./semantic.ts";

export const LEXICAL_ENRICHMENT_SCHEMA_VERSION = "lexical-enrichment-v1";

export const LEXICAL_ENRICHMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["entries"],
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["entry_key", "canonical_expression", "lemma", "common_senses", "derived_words", "useful_patterns", "needs_review", "review_notes"],
        properties: {
          entry_key: { type: "string" },
          canonical_expression: { type: "string" },
          lemma: { type: "string" },
          common_senses: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["pos", "definition_en", "meaning_zh"],
              properties: {
                pos: { type: "string", enum: [...LEXICAL_POS_VALUES] },
                definition_en: { type: "string" },
                meaning_zh: { type: "string" }
              }
            }
          },
          derived_words: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["expression", "relation", "meaning_zh"],
              properties: {
                expression: { type: "string" },
                relation: { type: "string" },
                meaning_zh: { type: "string" }
              }
            }
          },
          useful_patterns: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["pattern", "meaning_zh"],
              properties: {
                pattern: { type: "string" },
                meaning_zh: { type: "string" }
              }
            }
          },
          needs_review: { type: "boolean" },
          review_notes: { type: ["string", "null"] }
        }
      }
    }
  }
} as const;

export type ConsolidatedEntrySeed = LexicalEntryArtifact & {
  entry_key: string;
  sample_occurrences: LexicalOccurrenceArtifact[];
};

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function mergeReviewNotes(...values: Array<string | null | undefined>) {
  const notes = unique(values.flatMap((value) => value?.split("; ").filter(Boolean) ?? []));
  return notes.length ? notes.join("; ") : null;
}

export function consolidateLexicalEntries(occurrences: LexicalOccurrenceArtifact[]): ConsolidatedEntrySeed[] {
  const grouped = new Map<string, LexicalOccurrenceArtifact[]>();
  for (const occurrence of occurrences) {
    grouped.set(occurrence.entry_key, [...(grouped.get(occurrence.entry_key) ?? []), occurrence]);
  }
  return Array.from(grouped, ([entryKey, values]) => {
    const ordered = [...values].sort((left, right) =>
      left.source_type.localeCompare(right.source_type) ||
      left.source_item_id.localeCompare(right.source_item_id) ||
      left.content_block_id.localeCompare(right.content_block_id) ||
      left.start_offset - right.start_offset
    );
    const canonicalExpressions = unique(ordered.map((value) => value.canonical_expression));
    const lemmas = unique(ordered.map((value) => value.lemma.toLocaleLowerCase("en-US")));
    const conflictNotes = [
      canonicalExpressions.length > 1 ? "incompatible_canonicalization" : null,
      lemmas.length > 1 ? "lemma_conflict" : null
    ].filter((value): value is string => value !== null);
    const reviewStatus: LexicalReviewStatus = conflictNotes.length ? "needs_review" : "generated";
    const seed: ConsolidatedEntrySeed = {
      entry_key: entryKey,
      canonical_expression: canonicalExpressions[0],
      normalized_expression: ordered[0].normalized_expression,
      expression_type: ordered[0].expression_type,
      lemma: ordered[0].lemma,
      common_senses: [],
      derived_words: [],
      useful_patterns: [],
      review_status: reviewStatus,
      generation_version: LEXICAL_GENERATION_VERSION,
      review_notes: conflictNotes.length ? conflictNotes.join("; ") : null,
      sample_occurrences: ordered.slice(0, 4)
    };
    return seed;
  }).sort((left, right) => left.entry_key.localeCompare(right.entry_key));
}

function nonEmpty(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function nullable(value: unknown, label: string) {
  return value === null ? null : nonEmpty(value, label);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

export function applyEntryEnrichment(seeds: ConsolidatedEntrySeed[], payload: unknown): ConsolidatedEntrySeed[] {
  const root = asRecord(payload, "enrichment payload");
  if (!Array.isArray(root.entries)) throw new Error("enrichment payload.entries must be an array.");
  const seedByKey = new Map(seeds.map((seed) => [seed.entry_key, seed]));
  const enriched = new Map<string, ConsolidatedEntrySeed>();
  for (let index = 0; index < root.entries.length; index += 1) {
    const rawValue = root.entries[index];
    const raw = asRecord(rawValue, `entries[${index}]`);
    const key = nonEmpty(raw.entry_key, "entry.entry_key");
    const seed = seedByKey.get(key);
    if (!seed || enriched.has(key)) throw new Error(`Unknown or duplicate enrichment entry ${key}.`);
    if (!Array.isArray(raw.common_senses) || !Array.isArray(raw.derived_words) || !Array.isArray(raw.useful_patterns)) {
      throw new Error(`Enrichment entry ${key} has malformed arrays.`);
    }
    const commonSenses = raw.common_senses.map((value, senseIndex) => {
      const sense = asRecord(value, `entry.common_senses[${senseIndex}]`);
      const parsedPos = nonEmpty(sense.pos, "sense.pos") as LexicalPos;
      if (!(LEXICAL_POS_VALUES as readonly string[]).includes(parsedPos)) throw new Error(`Unknown sense POS ${parsedPos}.`);
      return {
        pos: parsedPos,
        definition_en: nonEmpty(sense.definition_en, "sense.definition_en"),
        meaning_zh: nonEmpty(sense.meaning_zh, "sense.meaning_zh")
      };
    });
    if (commonSenses.length === 0 || commonSenses.length > 4) throw new Error(`Entry ${key} must have 1-4 common senses.`);
    const derivedWords = raw.derived_words.map((value, derivedIndex) => {
      const derived = asRecord(value, `entry.derived_words[${derivedIndex}]`);
      return {
        expression: nonEmpty(derived.expression, "derived.expression"),
        relation: nonEmpty(derived.relation, "derived.relation"),
        meaning_zh: nonEmpty(derived.meaning_zh, "derived.meaning_zh")
      };
    });
    const usefulPatterns = raw.useful_patterns.map((value, patternIndex) => {
      const pattern = asRecord(value, `entry.useful_patterns[${patternIndex}]`);
      return {
        pattern: nonEmpty(pattern.pattern, "pattern.pattern"),
        meaning_zh: nonEmpty(pattern.meaning_zh, "pattern.meaning_zh")
      };
    });
    const notes = [seed.review_notes, nullable(raw.review_notes, "entry.review_notes")].filter(Boolean).join("; ") || null;
    if (typeof raw.needs_review !== "boolean") throw new Error(`Entry ${key} needs_review must be boolean.`);
    const enrichedEntry: ConsolidatedEntrySeed = {
      ...seed,
      canonical_expression: nonEmpty(raw.canonical_expression, "entry.canonical_expression"),
      lemma: nonEmpty(raw.lemma, "entry.lemma"),
      common_senses: commonSenses,
      derived_words: derivedWords,
      useful_patterns: usefulPatterns,
      review_status: seed.review_status === "needs_review" || raw.needs_review ? "needs_review" : "generated",
      review_notes: notes
    };
    const contentIssues = lexicalEntryContentIssues(enrichedEntry);
    if (contentIssues.length) throw new Error(`Enrichment entry ${key} failed QA: ${contentIssues.join(", ")}.`);
    enriched.set(key, enrichedEntry);
  }
  if (enriched.size !== seeds.length) throw new Error(`Expected ${seeds.length} enriched entries, received ${enriched.size}.`);
  return seeds.map((seed) => enriched.get(seed.entry_key)!);
}

export function mergeCachedEntryEnrichment(
  seed: ConsolidatedEntrySeed,
  cached: ConsolidatedEntrySeed
): ConsolidatedEntrySeed {
  return {
    ...seed,
    canonical_expression: cached.canonical_expression,
    lemma: cached.lemma,
    common_senses: cached.common_senses,
    derived_words: cached.derived_words,
    useful_patterns: cached.useful_patterns,
    review_status: seed.review_status === "needs_review" || cached.review_status === "needs_review"
      ? "needs_review"
      : "generated",
    review_notes: mergeReviewNotes(seed.review_notes, cached.review_notes)
  };
}
