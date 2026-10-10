type Occurrence = { surface_text: string; context_pos: string | null; context_meaning_zh: string;
  context_definition_en: string | null };
/** Canonical is the formal headword; source spelling is evidence, not a lemma.
 * Never lowercase/lemmatize it: canonical already encodes POS and proper case. */
export function wordbookContextForm(o: Occurrence, entry: { canonical_expression: string }) {
  return { expression: entry.canonical_expression, contextPos: o.context_pos,
    contextMeaningZh: o.context_meaning_zh, contextDefinitionEn: o.context_definition_en };
}
