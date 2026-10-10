type Occurrence = { surface_text: string; context_pos: string | null; context_meaning_zh: string;
  context_definition_en: string | null };
/** Display the stored source form/sense, independently of canonical identity. */
export function wordbookContextForm(o: Occurrence) {
  return { expression: o.surface_text, contextPos: o.context_pos,
    contextMeaningZh: o.context_meaning_zh, contextDefinitionEn: o.context_definition_en };
}
