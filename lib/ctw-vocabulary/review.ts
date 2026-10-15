import type { ReviewCard, ReviewRound, ReviewSession, ReviewSpellingGroup, ReviewSummary } from "../lexical/wordbookReview.ts";
import { localReview, reviewLocalState, type LocalReview } from "../lexical/wordbookReviewLocal.ts";
import { protectedReviewPrompt } from "../lexical/wordbookReviewPresentation.ts";
import type { AttemptResult, GradedAnswer, IrregularFormType, ListSource, VocabularyEntry } from "./model.ts";
import { FORM_LABELS, POS_LABELS, listLabel, vocabularySpellingShape } from "./round.ts";

export const CTW_REVIEW_NAMESPACE = "ctw-vocabulary-review";
export const CTW_REVIEW_ROOT = "/api/student/ctw-vocabulary/review";
export const ctwCacheKey = (url: string, _owner?: string) => `ctw-vocabulary:${url.replace("?", ":")}`;
export type CtwReviewMetadata = { source: ListSource; entries: VocabularyEntry[]; parent?: string };
export function ctwMetadata(round: Pick<ReviewRound, "metadata">): CtwReviewMetadata { return round.metadata as CtwReviewMetadata; }
export function ctwRangeLabel(session: ReviewSession & { source?: ListSource }) {
  const source = session.source;
  return `${source?.kind === "cefr_list" ? source.group.replace("-", "–") : "乱序版"} · ${source ? listLabel(source.listNumber) : "历史词测"}${session.mode === "retry" ? " · 错词再练" : ""}`;
}
// Comparison-only inflections do NOT expand accepted spelling answers.
export function vocabularyPromptForms(entry: Pick<VocabularyEntry, "word" | "senses" | "irregular_forms">) {
  const word = entry.word.toLowerCase(), forms = entry.irregular_forms.flatMap(form => form.answers);
  if (!/^[a-z]+$/.test(word)) return forms;
  if (entry.senses.some(s => s.pos === "verb" || s.pos === "noun")) {
    forms.push(word + "s", word + "es");
    if (/[^aeiou]y$/.test(word)) forms.push(word.slice(0, -1) + "ies");
  }
  if (entry.senses.some(s => s.pos === "verb")) {
    forms.push(word + "ed", word + "ing");
    if (word.endsWith("e")) forms.push(word + "d", word.slice(0, -1) + "ing");
    if (word.endsWith("ie")) forms.push(word.slice(0, -2) + "ying");
    if (/[^aeiou]y$/.test(word)) forms.push(word.slice(0, -1) + "ied");
    if (/[^aeiou][aeiou][^aeiouwxy]$/.test(word)) forms.push(word + word.slice(-1) + "ed", word + word.slice(-1) + "ing");
  }
  if (entry.senses.some(s => s.pos === "adjective" || s.pos === "adverb")) {
    forms.push(word + "er", word + "est");
    if (word.endsWith("e")) forms.push(word + "r", word + "st");
    if (/[^aeiou]y$/.test(word)) forms.push(word.slice(0, -1) + "ier", word.slice(0, -1) + "iest");
    if (/[^aeiou][aeiou][^aeiouwxy]$/.test(word)) forms.push(word + word.slice(-1) + "er", word + word.slice(-1) + "est");
  }
  return Array.from(new Set(forms));
}
/** Group same-tense forms for any entry, not a be-only presentation override.
 * Database form IDs/content stay intact; this fixed projection is snapshotted. */
function formLabel(entry: VocabularyEntry, type: IrregularFormType) {
  const hasPresentVariants = entry.irregular_forms.some(f => ["present_first_person_singular", "present_second_person_or_plural"].includes(f.form_type));
  return hasPresentVariants && type.startsWith("present_") ? "现在时" : FORM_LABELS[type];
}
export function ctwSpellingGroups(entry: VocabularyEntry): ReviewSpellingGroup[] {
  const groups: ReviewSpellingGroup[] = [];
  for (const form of entry.irregular_forms) {
    const label = formLabel(entry, form.form_type);
    const previous = groups.find(group => group.label === label);
    if (previous) {
      previous.accepted.push(...form.answers); previous.shapes!.push(...form.answers.map(answer => vocabularySpellingShape([answer])));
    } else groups.push({ id: form.form_type, label, accepted: [...form.answers], shape: vocabularySpellingShape(form.answers),
      requiredAll: true, shapes: form.answers.map(answer => vocabularySpellingShape([answer])) });
  }
  return [{ id: "base", shape: vocabularySpellingShape([entry.word]), accepted: [entry.word], ...(groups.length ? { label: "原形" } : {}) }, ...groups];
}
/** v1 had one input per database form, and treated variants as alternatives.
 * Keep entered text while projecting it into today's grouped required slots. */
export function ctwLegacyRowValues(card: ReviewCard, entry: VocabularyEntry, raw: { formType: IrregularFormType; spelling: string }[] = []) {
  return Object.fromEntries((card.spellingGroups ?? []).filter(group => group.id !== "base").map(group => {
    const values = group.accepted.map(() => ""), occupied = new Set<number>();
    for (const form of raw.filter(form => formLabel(entry, form.formType) === group.label)) {
      let index = group.accepted.findIndex((expected, n) => !occupied.has(n) && expected.toLowerCase() === form.spelling.trim().toLowerCase());
      if (index < 0) index = group.accepted.findIndex((expected, n) => !occupied.has(n) && expected.length === form.spelling.trim().length);
      if (index < 0) index = values.findIndex((_, n) => !occupied.has(n));
      if (index >= 0) { occupied.add(index); values[index] = form.spelling; }
    }
    return [group.id, values.join(" / ")];
  }));
}
export function ctwReviewCard(entry: VocabularyEntry, index: number): ReviewCard {
  const forms = vocabularyPromptForms(entry);
  return { itemId: entry.entry_id, position: index + 1, kind: "spelling", sourceTypes: ["ctw"], options: [], targetForms: forms,
    prompt: entry.senses.map(s => `${POS_LABELS[s.pos]} ${protectedReviewPrompt(s.meaning_zh, entry.word, forms)}`).join("\n"),
    studySenses: entry.senses.map(s => ({ pos: POS_LABELS[s.pos], meaning: s.meaning_zh, example: s.example_en })),
    expected: { expression: entry.word, pos: null, standardPos: null, meaning: entry.senses.map(s => s.meaning_zh).join("；"),
      definitionEn: null, correctOptionId: null, examples: entry.senses.map(s => ({ text: s.example_en, kind: "sentence" })) },
    spellingGroups: ctwSpellingGroups(entry) };
}
export function createCtwReviewRound(id: string, source: ListSource, entries: VocabularyEntry[], parent?: string, startedAt = new Date().toISOString()): ReviewRound {
  if (!entries.length || entries.length > 50 || new Set(entries.map(e => e.entry_id)).size !== entries.length) throw new Error("CTW_VOCAB_INVALID_ROUND");
  const cards = entries.map(ctwReviewCard);
  const round: ReviewRound = { session: { session_id: id, domain: "reading", source_types: ["ctw"], mode: parent ? "retry" : "random",
      settings: {}, timezone: "Asia/Shanghai", started_at: startedAt, completed_at: null, status: "active", total: entries.length, answered: 0, parent_session_id: parent ?? null },
    cards, item: cards[0], composition: { spellingPos: 0, meaningChoice: 0 }, flow: { phase: "study", position: 1 },
    summary: { correct: 0, incorrect: 0, spellingCorrect: 0, spellingTotal: 0, posCorrect: 0, posTotal: 0, choiceCorrect: 0, choiceTotal: 0 },
    metadata: { source, entries, ...(parent ? { parent } : {}) } };
  return round;
}
export function projectCtwRound(local: LocalReview): ReviewRound {
  return { ...reviewLocalState(local), metadata: local.round.metadata,
    cards: local.round.cards.map(card => ({ ...card, ...(local.answers[card.itemId] ? { answer: local.answers[card.itemId] } : {}) })) };
}
export function ctwRawAnswers(local: LocalReview) {
  return local.round.cards.map(card => ({ entryId: card.itemId,
    spelling: local.answers[card.itemId]?.student.spellings?.base ?? "",
    irregularSpellings: (card.spellingGroups ?? []).filter(group => group.id !== "base").map(group => ({ formType: group.id as IrregularFormType,
      spelling: local.answers[card.itemId]?.student.spellings?.[group.id] ?? "" })) }));
}
/** Serialize the shared server-replayed assessments, never run a second CTW
 * batch grader with different alternative-answer semantics at completion. */
export function ctwSavedAnswers(local: LocalReview): GradedAnswer[] {
  const metadata = ctwMetadata(local.round), raw = ctwRawAnswers(local);
  return local.round.cards.map((card, index) => {
    const entry = metadata.entries.find(item => item.entry_id === card.itemId)!, answer = local.answers[card.itemId];
    if (!answer) throw new Error("CTW_VOCAB_INCOMPLETE");
    return { ...raw[index], word: entry.word, listNumber: entry.list_number, listPosition: entry.list_position, cefr: entry.cefr,
      senses: entry.senses, sourceSha256: entry.source_sha256, acceptedAnswers: [entry.word], baseCorrect: answer.assessments.base,
      correct: answer.correct, irregularResults: raw[index].irregularSpellings.map(form => ({ ...form,
        acceptedAnswers: card.spellingGroups!.find(group => group.id === form.formType)!.accepted,
        requiredAll: card.spellingGroups!.find(group => group.id === form.formType)!.requiredAll ?? false,
        correct: answer.assessments[form.formType] })),
      ...(index === 0 ? { source: metadata.source } : {}) };
  });
}
/** Historical snapshots are adapted, never regraded or updated. */
export function legacyCtwReviewRound(result: AttemptResult): ReviewRound {
  const groups = new Map<string, typeof result.answers>();
  for (const answer of result.answers) groups.set(answer.entryId, [...(groups.get(answer.entryId) ?? []), answer]);
  const entries = Array.from(groups.values()).map(answers => {
    const a = answers[0];
    return { entry_id: a.entryId, word: a.word, list_number: a.listNumber, list_position: a.listPosition, cefr: a.cefr,
      senses: a.senses, source_sha256: a.sourceSha256,
      irregular_forms: a.irregularResults?.map(f => ({ form_type: f.formType, answers: f.acceptedAnswers })) ?? [] };
  });
  const originalSource = result.answers[0]?.source;
  const source: ListSource = originalSource?.kind === "list" || originalSource?.kind === "cefr_list" ? originalSource
    : { kind: "list", listNumber: entries[0].list_number };
  const round = createCtwReviewRound(result.attempt_id, source, entries, undefined, result.submitted_at);
  const local = localReview("historical", round); local.phase = "result";
  for (const [id, answers] of Array.from(groups.entries())) {
    const a = answers[0], card = round.cards.find(c => c.itemId === id)!, entry = entries.find(e => e.entry_id === id)!;
    const rows = (card.spellingGroups ?? []).filter(group => group.id !== "base").map(group => {
      const saved = (a.irregularResults ?? []).filter(form => formLabel(entry, form.formType) === group.label);
      group.requiredAll = saved.length > 1 || saved.some(form => form.requiredAll);
      return { id: group.id, spelling: saved.map(form => form.spelling).join(" / "), correct: saved.every(form => form.correct) };
    });
    const assessments = { base: a.baseCorrect ?? a.correct, ...Object.fromEntries(rows.map(row => [row.id, row.correct])) };
    local.answers[id] = { ...card.expected, student: { spellings: { base: a.spelling, ...Object.fromEntries(rows.map(row => [row.id, row.spelling])) } },
      assessments, correct: answers.every(item => item.correct), submittedAt: result.submitted_at };
  }
  const projected = projectCtwRound(local); projected.session.completed_at = result.submitted_at;
  return projected;
}
export function ctwHistorySession(row: { session_id: string; source: ListSource; started_at: string; status: "active" | "completed"; total: number; answered: number; summary: ReviewSummary; parent_session_id?: string | null }) {
  return { ...row, domain: "reading" as const, source_types: ["ctw"], mode: row.parent_session_id ? "retry" as const : "random" as const,
    settings: {}, timezone: "Asia/Shanghai", completed_at: row.status === "completed" ? row.started_at : null, parent_session_id: row.parent_session_id ?? null };
}
