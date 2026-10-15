// Offline review/import QA only. Runtime vocabulary/allowed answers come from
// the database, never from this patch manifest or a frontend spelling override.
import type { IrregularForm, ReviewedVocabulary } from "./model.ts";
export type SpellingAdjustment = { word: string; before: IrregularForm[]; after: IrregularForm[]; reason: string };
export function applyVocabularySpellingReview(rows: ReviewedVocabulary[], changes: SpellingAdjustment[]) {
  const adjusted = structuredClone(rows), seen = new Set<string>();
  for (const change of changes) {
    const entry = adjusted.find(row => row.word === change.word);
    if (!entry || seen.has(change.word) || JSON.stringify(entry.irregular_forms) !== JSON.stringify(change.before)) throw new Error(`Spelling review baseline mismatch: ${change.word}`);
    seen.add(change.word); entry.irregular_forms = structuredClone(change.after);
  }
  return adjusted;
}
