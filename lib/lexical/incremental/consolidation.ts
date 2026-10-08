import { lexicalEntryKey, LEXICAL_GENERATION_VERSION, type LexicalExpressionType, type LexicalOccurrenceArtifact } from "../generationTypes.ts";
import { normalizeLexicalExpression, normalizeLexicalSurface } from "../normalize.ts";
import { productionId } from "../production.ts";
import type { ProductionEntryRow } from "./productionBaseline.server.ts";

export type DeltaConflict = {
  entry_key: string;
  reasons: string[];
  canonical_variants: string[];
  lemma_variants: string[];
  occurrences: number;
  source_occurrence_ids: string[];
};

export type DeltaConsolidation = {
  occurrences: LexicalOccurrenceArtifact[];
  newEntries: Array<{
    entry_key: string;
    entry_id: string;
    canonical_expression: string;
    normalized_expression: string;
    expression_type: LexicalExpressionType;
    lemma: string;
  }>;
  reusedEntries: Array<{
    entry_key: string;
    entry_id: string;
  }>;
  conflicts: DeltaConflict[];
  assignments: Map<string, { entry_key: string; entry_id: string; reused: boolean }>;
};

export const occurrenceIdentityOf = (occurrence: Pick<LexicalOccurrenceArtifact,
  "source_type" | "source_item_id" | "content_block_id" | "start_offset" | "end_offset">) =>
  `${occurrence.source_type}:${occurrence.source_item_id}:${occurrence.content_block_id}:${occurrence.start_offset}:${occurrence.end_offset}`;

/** Recompute derived identity from the current canonical fields; never trust stale keys. */
export function deriveIncrementalOccurrence(occurrence: LexicalOccurrenceArtifact): LexicalOccurrenceArtifact {
  const normalizedExpression = normalizeLexicalExpression(occurrence.canonical_expression, occurrence.expression_type);
  const entryKey = lexicalEntryKey(normalizedExpression, occurrence.expression_type);
  const normalizedSurface = occurrence.layer === 1
    ? normalizeLexicalSurface(occurrence.surface_text)
    : normalizeLexicalExpression(occurrence.surface_text, occurrence.expression_type);
  if (occurrence.normalized_surface !== normalizedSurface) throw new Error("Occurrence normalized_surface derivation changed.");
  if (occurrence.layer === 1 && (occurrence.normalized_expression !== normalizedExpression || occurrence.entry_key !== entryKey)) {
    throw new Error("Layer-1 occurrence identity is not its own derivation.");
  }
  return { ...occurrence, normalized_expression: normalizedExpression, entry_key: entryKey };
}

const uniqueSorted = (values: string[]) => Array.from(new Set(values)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);

/**
 * Consolidates the delta occurrence set against the live production entry universe:
 * exact identity reuse when the key already exists, new base identities otherwise.
 * Canonical/lemma conflicts and homograph collisions are withheld, never auto-reconciled.
 */
export function consolidateIncrementalDelta(input: {
  occurrences: LexicalOccurrenceArtifact[];
  productionEntries: ProductionEntryRow[];
  /** Explicit reviewed decisions, bound to exact delta occurrence identities; never model guesses. */
  identityVariantAssignments?: ReadonlyMap<string, string>;
}): DeltaConsolidation {
  const productionByKey = new Map<string, ProductionEntryRow>();
  const productionIdentities = new Map<string, ProductionEntryRow>();
  const identitiesByBase = new Map<string, ProductionEntryRow[]>();
  for (const entry of input.productionEntries) {
    const identity = `${entry.normalized_expression}\u0000${entry.expression_type}\u0000${entry.identity_variant}`;
    if (productionIdentities.has(identity)) throw new Error("Production entry identity is not unique.");
    productionIdentities.set(identity, entry);
    const base = `${entry.normalized_expression}\u0000${entry.expression_type}`;
    identitiesByBase.set(base, [...(identitiesByBase.get(base) ?? []), entry]);
    if (entry.identity_variant === "") {
      if (productionByKey.has(base)) throw new Error("Production base entry identity is not unique.");
      productionByKey.set(base, entry);
    }
  }

  const derived = input.occurrences.map(deriveIncrementalOccurrence);
  const seenSpans = new Set<string>();
  for (const occurrence of derived) {
    const span = occurrenceIdentityOf(occurrence);
    if (seenSpans.has(span)) throw new Error(`Duplicate delta occurrence identity ${span}.`);
    seenSpans.add(span);
  }

  const groups = new Map<string, LexicalOccurrenceArtifact[]>();
  for (const occurrence of derived) {
    const variant = input.identityVariantAssignments?.get(occurrenceIdentityOf(occurrence)) ?? "";
    const key = variant ? `${occurrence.entry_key}\u0000identity-variant:${variant}` : occurrence.entry_key;
    groups.set(key, [...(groups.get(key) ?? []), occurrence]);
  }

  const conflicts: DeltaConflict[] = [];
  const newEntries: DeltaConsolidation["newEntries"] = [];
  const reusedEntries: DeltaConsolidation["reusedEntries"] = [];
  const assignments = new Map<string, { entry_key: string; entry_id: string; reused: boolean }>();
  const acceptedGroups = new Map<string, LexicalOccurrenceArtifact[]>();

  for (const [entryKey, values] of Array.from(groups).sort(([left], [right]) => left < right ? -1 : 1)) {
    const canonical = uniqueSorted(values.map((occurrence) => occurrence.canonical_expression));
    const lemmas = uniqueSorted(values.map((occurrence) => occurrence.lemma.toLocaleLowerCase("en-US")));
    const reasons: string[] = [];
    if (canonical.length > 1) reasons.push("incompatible_canonicalization");
    if (lemmas.length > 1) reasons.push("lemma_conflict");
    if (reasons.length) {
      conflicts.push({
        entry_key: entryKey,
        reasons,
        canonical_variants: canonical,
        lemma_variants: uniqueSorted(values.map((occurrence) => occurrence.lemma)),
        occurrences: values.length,
        source_occurrence_ids: values.map(occurrenceIdentityOf)
      });
      continue;
    }
    const first = values[0];
    const variant = input.identityVariantAssignments?.get(occurrenceIdentityOf(first)) ?? "";
    const identities = identitiesByBase.get(first.entry_key) ?? [];
    const existing = variant ? productionIdentities.get(`${first.normalized_expression}\u0000${first.expression_type}\u0000${variant}`) : productionByKey.get(first.entry_key);
    const ambiguous = identities.filter(entry => entry.canonical_expression === first.canonical_expression
      && (entry.lemma ?? "").toLocaleLowerCase("en-US") === first.lemma.toLocaleLowerCase("en-US")).length > 1;
    if ((ambiguous && values.some(value => !input.identityVariantAssignments?.has(occurrenceIdentityOf(value)))) || (variant && !existing)) {
      conflicts.push({ entry_key: entryKey, reasons: ["homograph_identity_requires_review"], canonical_variants: canonical,
        lemma_variants: lemmas, occurrences: values.length, source_occurrence_ids: values.map(occurrenceIdentityOf) });
      continue;
    }
    if (existing) {
      if (existing.canonical_expression !== first.canonical_expression
        || (existing.lemma ?? "").toLocaleLowerCase("en-US") !== first.lemma.toLocaleLowerCase("en-US")) {
        conflicts.push({
          entry_key: entryKey,
          reasons: ["production_entry_convention_mismatch"],
          canonical_variants: [existing.canonical_expression, first.canonical_expression],
          lemma_variants: [existing.lemma ?? "", first.lemma],
          occurrences: values.length,
          source_occurrence_ids: values.map(occurrenceIdentityOf)
        });
        continue;
      }
      reusedEntries.push({ entry_key: entryKey, entry_id: existing.entry_id });
      acceptedGroups.set(entryKey, values);
      for (const occurrence of values) {
        assignments.set(occurrenceIdentityOf(occurrence), { entry_key: entryKey, entry_id: existing.entry_id, reused: true });
      }
      continue;
    }
    // New base identity: refuse when the same normalized/type identity already exists under a
    // different (homograph variant) production entry; that needs human resolution, not a new key.
    const variantCollision = (identitiesByBase.get(`${first.normalized_expression}\u0000${first.expression_type}`) ?? [])
      .find((entry) => entry.identity_variant !== "");
    if (variantCollision) {
      conflicts.push({
        entry_key: entryKey,
        reasons: ["homograph_identity_requires_review"],
        canonical_variants: [variantCollision.canonical_expression, first.canonical_expression],
        lemma_variants: [variantCollision.lemma ?? "", first.lemma],
        occurrences: values.length,
        source_occurrence_ids: values.map(occurrenceIdentityOf)
      });
      continue;
    }
    const entryId = productionId("entry", entryKey);
    newEntries.push({
      entry_key: entryKey,
      entry_id: entryId,
      canonical_expression: first.canonical_expression,
      normalized_expression: first.normalized_expression,
      expression_type: first.expression_type,
      lemma: first.lemma
    });
    acceptedGroups.set(entryKey, values);
    for (const occurrence of values) {
      assignments.set(occurrenceIdentityOf(occurrence), { entry_key: entryKey, entry_id: entryId, reused: false });
    }
  }

  const acceptedOccurrences = Array.from(acceptedGroups.values()).flat()
    .sort((left, right) => occurrenceIdentityOf(left) < occurrenceIdentityOf(right) ? -1 : 1);
  return { occurrences: acceptedOccurrences, newEntries, reusedEntries, conflicts, assignments };
}

export function deltaEntryRow(entry: DeltaConsolidation["newEntries"][number]) {
  return {
    entry_id: entry.entry_id,
    canonical_expression: entry.canonical_expression,
    normalized_expression: entry.normalized_expression,
    expression_type: entry.expression_type,
    lemma: entry.lemma,
    common_senses: [] as unknown[],
    derived_words: [] as unknown[],
    useful_patterns: [] as unknown[],
    review_status: "generated",
    generation_version: LEXICAL_GENERATION_VERSION,
    review_notes: null as string | null,
    identity_variant: ""
  };
}

export function deltaOccurrenceRow(occurrence: LexicalOccurrenceArtifact, entryId: string) {
  return {
    occurrence_id: productionId("occurrence", occurrenceIdentityOf(occurrence)),
    entry_id: entryId,
    source_type: occurrence.source_type,
    source_item_id: occurrence.source_item_id,
    content_block_id: occurrence.content_block_id,
    sentence_id: occurrence.sentence_id,
    source_anchor_id: occurrence.source_anchor_id,
    surface_text: occurrence.surface_text,
    normalized_surface: occurrence.normalized_surface,
    start_offset: occurrence.start_offset,
    end_offset: occurrence.end_offset,
    context_pos: occurrence.context_pos,
    context_meaning_zh: occurrence.context_meaning_zh,
    context_definition_en: occurrence.context_definition_en,
    context_text: occurrence.context_text,
    review_status: occurrence.review_status,
    generation_version: LEXICAL_GENERATION_VERSION,
    review_notes: occurrence.review_notes
  };
}
