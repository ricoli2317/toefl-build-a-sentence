// Offline review/import QA only. Runtime vocabulary/allowed answers come from
// the database, never from this patch manifest or a frontend spelling override.
import type { IrregularForm, IrregularFormType, ReviewedVocabulary } from "./model.ts";
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

/** Offline QA candidates, not an automatic runtime spelling filter. A rule
 * only matches a spelling actually present in a reviewed form. Multi-variant
 * forms remain explicitly required by the user's policy, even with an -ed
 * variant; do not silently remove burned/learned or invent new answers. */
export function regularVocabularyInflection(word: string, type: IrregularFormType, answer: string): string | null {
  const base = word.toLowerCase(), value = answer.toLowerCase();
  if (type === "plural" || type === "present_third_person_singular") {
    if (value === base + "s") return "+s";
    if (value === base + "es") return "+es";
    if (/[^aeiou]y$/.test(base) && value === base.slice(0, -1) + "ies") return "y → ies";
    if (type === "plural" && base.endsWith("fe") && value === base.slice(0, -2) + "ves") return "fe → ves (TPS)";
    if (type === "plural" && base.endsWith("f") && value === base.slice(0, -1) + "ves") return "f → ves (TPS)";
  }
  if (type === "past" || type === "past_participle") {
    if (value === base + "ed") return "+ed";
    if (base.endsWith("e") && value === base + "d") return "+d";
    if (/[^aeiou]y$/.test(base) && value === base.slice(0, -1) + "ied") return "y → ied";
    if (/[^aeiou][aeiou][^aeiouwxy]$/.test(base) && value === base + base.slice(-1) + "ed") return "double consonant + ed";
  }
  return null;
}
export function auditRegularVocabularyForms(rows: ReviewedVocabulary[]) {
  const findings = rows.flatMap(row => row.irregular_forms.flatMap(form => form.answers.flatMap(answer => {
    const rule = regularVocabularyInflection(row.word, form.form_type, answer);
    return rule ? [{ word: row.word, formType: form.form_type, answer, rule, allAnswers: form.answers,
      decision: form.answers.length > 1 ? "keep-multiple-variants" : "single-regular-review" }] : [];
  })));
  return { words: rows.length, wordsWithForms: rows.filter(row => row.irregular_forms.length).length,
    formGroups: rows.reduce((total, row) => total + row.irregular_forms.length, 0),
    spellings: rows.reduce((total, row) => total + row.irregular_forms.reduce((n, form) => n + form.answers.length, 0), 0),
    findings, singleRegularForms: findings.filter(finding => finding.decision === "single-regular-review") };
}
