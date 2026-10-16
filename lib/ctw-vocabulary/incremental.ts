// Offline delta planning/review. No database, environment, model calls or historical rebuilds.
import { createHash } from "node:crypto";
import { baselineValue } from "../lexical/incremental/baselineHash.ts";
import { enumerateCtwBlocks, type CtwLexicalInput } from "../lexical/enumerators/ctw.server.ts";
import { validateReviewedRows } from "./import.ts";
import { normalizeVocabularySpelling, type VocabularyEntry, type VocabularySense, type IrregularForm, type CefrGroup } from "./model.ts";
import { ctwSpellingGroups } from "./review.ts";
import { regularVocabularyInflection } from "./spelling-review.ts";

export const digest = (value: unknown): string => createHash("sha256").update(baselineValue(value)).digest("hex");
export type EntryRow = VocabularyEntry & { normalized_word: string };
export type Membership = { entry_id: string; cefr_group: CefrGroup; list_number: number; list_position: number };
export type CtwSnapshot = { canonical: CtwLexicalInput[]; entries: EntryRow[]; memberships: Membership[] };
export type CtwCheckpoint = { version: "ctw-incremental-checkpoint-v1"; sources: Record<string, string>; run?: string;
  new_canonical_scope?: { ids: string[]; authority: string } };
export type Candidate = { id: string; canonical_id: string; slot_id: string; answer: string; normalized_answer: string;
  context: string; base_candidates: string[] };
export type CtwPlan = { version: "ctw-incremental-plan-v1"; snapshot: CtwSnapshot; previous: CtwCheckpoint;
  sources: Record<string, string>; new_canonical: string[]; unchanged: string[]; changed: string[]; removed: string[]; candidates: Candidate[] };
export type Decision = { candidate_id: string; base_form: string; action: "reuse" | "sense" | "new";
  reason: string; sense_index?: number; sense?: VocabularySense };
export type NewWord = { word: string; cefr: VocabularyEntry["cefr"]; senses: VocabularySense[]; irregular_forms: IrregularForm[];
  cefr_review: { reference: "Oxford 3000/5000"; locator: string; pos_sense_rationale: string };
  forms_review: string };
export type CtwReview = { version: "ctw-incremental-review-v1"; plan_sha256: string; reviewer: string;
  decisions: Decision[]; new_words: NewWord[] };
export type CtwPublication = { version: "ctw-incremental-publication-v1"; plan: CtwPlan; review: CtwReview;
  reuse: { candidate_id: string; entry_id: string; sense_index: number }[];
  senses: { entry_id: string; word: string; senses: VocabularySense[] }[];
  new_entries: EntryRow[]; memberships: Membership[]; next_checkpoint: CtwCheckpoint };

const requireText = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`Missing ${name}`);
};
const norm = (word: string) => normalizeVocabularySpelling(word);
const senseKey = (sense: VocabularySense) => digest([sense.pos, sense.meaning_zh.normalize("NFKC").trim().replace(/\s+/g, " ")]);
export const cefrGroup = (cefr: VocabularyEntry["cefr"]): CefrGroup => cefr === "C1" || cefr === "C2" ? "C1-C2" : cefr;
const unique = (values: unknown[], label: string) => {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
};

/** Strict topology check before sharing the existing canonical reconstruction/anchor extractor. */
export function canonicalSources(canonical: CtwLexicalInput[]) {
  const sources: Record<string, string> = Object.create(null);
  for (const item of canonical) {
    requireText(item.sourceItemId, "canonical ID");
    if (Object.hasOwn(sources, item.sourceItemId)) throw new Error("Duplicate canonical identity (REUSE must refer to one canonical)");
    unique(item.paragraphs.map(p => p.paragraphId), "paragraph");
    unique(item.paragraphs.map(p => p.paragraphOrder), "paragraph order");
    unique(item.slots.map(s => s.slotId), "slot");
    unique(item.segments.map(s => `${s.paragraphId}:${s.segmentOrder}`), "segment order");
    const paragraphs = new Set(item.paragraphs.map(p => p.paragraphId));
    item.paragraphs.forEach(p => requireText(p.paragraphId, "paragraph ID"));
    item.slots.forEach(s => { requireText(s.slotId, "slot ID"); if (!paragraphs.has(s.paragraphId)) throw new Error("Unknown slot paragraph"); });
    if (!paragraphs.size || !item.slots.length || item.paragraphs.some(p => !Number.isInteger(p.paragraphOrder) || p.paragraphOrder < 1)
      || item.segments.some(s => !paragraphs.has(s.paragraphId)
      || !["blank", "text"].includes(s.segmentType) || !Number.isInteger(s.segmentOrder) || s.segmentOrder < 1
      || (s.segmentType === "text" ? typeof s.textContent !== "string" || s.slotId !== null
        : s.textContent !== null || typeof s.slotId !== "string"))) throw new Error("Invalid CTW topology");
    const used = item.segments.filter(s => s.segmentType === "blank").map(s => s.slotId);
    unique(used, "placed slot");
    if (used.length !== item.slots.length || item.slots.some(s => !used.includes(s.slotId))) throw new Error("Unplaced CTW slot");
    item.slots.forEach(s => requireText(s.answer, "correct answer"));
    const blocks = enumerateCtwBlocks(item);
    sources[item.sourceItemId] = digest(blocks);
  }
  return { ...sources };
}

function assertLayout(rows: { list_number: number; list_position: number }[], label: string) {
  const sorted = [...rows].sort((a, b) => a.list_number - b.list_number || a.list_position - b.list_position);
  sorted.forEach((r, i) => {
    if (r.list_number !== Math.floor(i / 50) + 1 || r.list_position !== i % 50 + 1) throw new Error(`Invalid ${label} List layout`);
  });
}
export function validateSnapshot(snapshot: CtwSnapshot) {
  canonicalSources(snapshot.canonical);
  if (!snapshot.entries.length) throw new Error("CTW initialized baseline required; incremental is not an initializer");
  validateReviewedRows(snapshot.entries.map(e => ({ word: e.word, list_id: "List 01", cefr: e.cefr, senses: e.senses, irregular_forms: e.irregular_forms })));
  unique(snapshot.entries.map(e => e.entry_id), "entry ID");
  unique(snapshot.memberships.map(m => m.entry_id), "membership");
  assertLayout(snapshot.entries, "mixed");
  for (const e of snapshot.entries) {
    if (e.normalized_word !== e.word.toLowerCase() || !/^[a-f\d]{64}$/.test(e.source_sha256)) throw new Error("Invalid entry baseline");
    const m = snapshot.memberships.find(m => m.entry_id === e.entry_id);
    if (!m || m.cefr_group !== cefrGroup(e.cefr)) throw new Error("CEFR membership baseline mismatch");
  }
  if (snapshot.memberships.length !== snapshot.entries.length) throw new Error("Orphan membership");
  for (const g of ["A1", "A2", "B1", "B2", "C1-C2"]) assertLayout(snapshot.memberships.filter(m => m.cefr_group === g), g);
}

/** Suggestions only: never silently strip suffixes or infer a sense. Reviewer resolves homographs/POS. */
function suggestBases(answer: string, entries: EntryRow[]) {
  const known = entries.filter(e => norm(e.word) === answer || e.irregular_forms.some(f => f.answers.some(a => norm(a) === answer))
    || ["plural", "present_third_person_singular", "past", "past_participle"].some(type =>
      regularVocabularyInflection(e.word, type as IrregularForm["form_type"], answer))
    || (e.senses.some(s => s.pos === "verb") && [e.word + "ing", e.word.replace(/e$/, "") + "ing"].includes(answer)))
    .map(e => e.word);
  const suggestions = [answer];
  // Morphology proposals are deliberately over-inclusive (e.g. saw is ambiguous), never accepted data.
  if (/ies$/.test(answer)) suggestions.push(answer.slice(0, -3) + "y");
  if (/ied$/.test(answer)) suggestions.push(answer.slice(0, -3) + "y");
  for (const suffix of ["ing", "ed"]) if (answer.length > suffix.length + 2 && answer.endsWith(suffix)) {
    const stem = answer.slice(0, -suffix.length);
    suggestions.push(stem, stem + "e");
    if (/([^aeiou])\1$/.test(stem)) suggestions.push(stem.slice(0, -1));
  }
  if (answer.length > 3 && answer.endsWith("s")) suggestions.push(answer.slice(0, -1));
  if (answer.length > 4 && answer.endsWith("es")) suggestions.push(answer.slice(0, -2));
  return Array.from(new Set([...known, ...suggestions]));
}
export function planCtw(snapshot: CtwSnapshot, checkpoint: CtwCheckpoint): CtwPlan {
  validateSnapshot(snapshot);
  if (checkpoint.version !== "ctw-incremental-checkpoint-v1" || !checkpoint.sources
    || Object.values(checkpoint.sources).some(h => !/^[a-f\d]{64}$/.test(h))) throw new Error("Explicit reviewed CTW checkpoint required");
  const sources = canonicalSources(snapshot.canonical);
  const keys = Object.keys(sources).sort();
  const scope = checkpoint.new_canonical_scope;
  if (scope) {
    requireText(scope.authority, "explicit user confirmation that only these canonical IDs remain unprocessed");
    if (Object.keys(checkpoint.sources).length || !Array.isArray(scope.ids) || !scope.ids.length
      || scope.ids.some(id => !Object.hasOwn(sources, id))) throw new Error("Invalid explicitly confirmed NEW canonical scope");
    unique(scope.ids, "NEW canonical scope ID");
  }
  const newIds = scope ? [...scope.ids].sort() : keys.filter(k => !Object.hasOwn(checkpoint.sources, k));
  const candidates: Candidate[] = [];
  for (const item of snapshot.canonical.filter(c => newIds.includes(c.sourceItemId)).sort((a, b) => a.sourceItemId < b.sourceItemId ? -1 : 1)) {
    for (const block of enumerateCtwBlocks(item)) for (const anchor of block.anchors ?? []) {
      const answer = anchor.expectedText!, normalized = norm(answer);
      candidates.push({ id: digest([item.sourceItemId, anchor.anchorId]), canonical_id: item.sourceItemId,
        slot_id: anchor.anchorId, answer, normalized_answer: normalized, context: block.text,
        base_candidates: suggestBases(normalized, snapshot.entries) });
    }
  }
  return { version: "ctw-incremental-plan-v1", snapshot: structuredClone(snapshot), previous: structuredClone(checkpoint), sources,
    new_canonical: newIds, unchanged: scope ? keys.filter(k => !newIds.includes(k)) : keys.filter(k => checkpoint.sources[k] === sources[k]),
    changed: scope ? [] : keys.filter(k => Object.hasOwn(checkpoint.sources, k) && checkpoint.sources[k] !== sources[k]),
    removed: scope ? [] : Object.keys(checkpoint.sources).filter(k => !Object.hasOwn(sources, k)).sort(), candidates };
}

/** Frozen acceptance rules, not a runtime override. General unknown forms require explicit review. */
export function validateIncrementalForms(word: string, forms: IrregularForm[]) {
  const pair = (type: IrregularForm["form_type"], answers: string[]) => ({ form_type: type, answers });
  const policy: Record<string, IrregularForm[]> = {
    be: [pair("present_first_person_singular", ["am"]), pair("present_third_person_singular", ["is"]), pair("present_second_person_or_plural", ["are"]),
      pair("past_first_or_third_person_singular", ["was"]), pair("past_second_person_or_plural", ["were"]), pair("past_participle", ["been"])],
    get: [pair("past", ["got"]), pair("past_participle", ["got", "gotten"])],
    far: [pair("comparative", ["farther", "further"]), pair("superlative", ["farthest", "furthest"])],
    burn: [pair("past", ["burnt", "burned"]), pair("past_participle", ["burnt", "burned"])],
    learn: [pair("past", ["learnt", "learned"]), pair("past_participle", ["learnt", "learned"])],
    life: [], leaf: [], craftsperson: [pair("plural", ["craftspeople"])], millennium: [pair("plural", ["millennia"])]
  };
  if (Object.hasOwn(policy, word) && digest(policy[word]) !== digest(forms)) throw new Error(`Phase 3 irregular policy mismatch: ${word}`);
  for (const f of forms) {
    unique(f.answers.map(norm), "normalized irregular form");
    if (f.answers.length === 1 && regularVocabularyInflection(word, f.form_type, f.answers[0])) throw new Error(`Single regular form must not become an irregular question: ${word}`);
  }
  const groups = ctwSpellingGroups({ word, irregular_forms: forms } as VocabularyEntry).slice(1);
  if (groups.some(g => !g.requiredAll || new Set(g.accepted.map(norm)).size !== g.accepted.length)) throw new Error("Invalid required-all form groups");
}

function deterministicId(key: string) {
  const h = digest(["ctw-incremental-entry-v1", key]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function prepareCtw(plan: CtwPlan, review: CtwReview): CtwPublication {
  if (digest(plan) !== review.plan_sha256 || review.version !== "ctw-incremental-review-v1") throw new Error("Stale review/plan binding");
  if (digest(planCtw(plan.snapshot, plan.previous)) !== digest(plan)) throw new Error("Invalid CTW plan");
  if (plan.changed.length) throw new Error("Previously synced canonical changed; explicit separate adjudication required, never silently rebase");
  requireText(review.reviewer, "reviewer");
  unique(review.decisions.map(d => d.candidate_id), "review decision");
  unique(review.new_words.map(w => norm(w.word)), "new base form");
  if (review.decisions.length !== plan.candidates.length) throw new Error("Unresolved candidates; every answer context needs confirmation");
  const existing = new Map(plan.snapshot.entries.map(e => [norm(e.word), e]));
  const newWords = new Map(review.new_words.map(w => [norm(w.word), w]));
  for (const w of review.new_words) {
    if (existing.has(norm(w.word))) throw new Error("New word duplicates existing base form");
    validateReviewedRows([{ word: w.word, list_id: "List 01", cefr: w.cefr, senses: w.senses, irregular_forms: w.irregular_forms }]);
    unique(w.senses.map(senseKey), "new sense");
    if (w.cefr_review?.reference !== "Oxford 3000/5000") throw new Error("Oxford CEFR review required (no legacy automatic A2 grading)");
    requireText(w.cefr_review.locator, "Oxford reference/lookup result");
    requireText(w.cefr_review.pos_sense_rationale, "POS/sense CEFR rationale");
    requireText(w.forms_review, "irregular review including regular/no-additional-forms decision");
    validateIncrementalForms(norm(w.word), w.irregular_forms);
  }
  const reuse: CtwPublication["reuse"] = [], additions = new Map<string, VocabularySense[]>(), referenced = new Set<string>();
  const candidateIds = new Set(plan.candidates.map(c => c.id));
  for (const d of review.decisions) {
    if (!candidateIds.has(d.candidate_id)) throw new Error("Out-of-scope answer decision");
    requireText(d.reason, "context/base-form decision reason");
    if (d.base_form !== norm(d.base_form)) throw new Error("Unnormalized base form");
    const entry = existing.get(d.base_form);
    if (d.action === "reuse") {
      if (!entry || !Number.isInteger(d.sense_index) || !entry.senses[d.sense_index!] || d.sense !== undefined) throw new Error("Invalid existing-sense reference");
      reuse.push({ candidate_id: d.candidate_id, entry_id: entry.entry_id, sense_index: d.sense_index! });
    } else if (d.action === "sense") {
      if (!entry || !d.sense || d.sense_index !== undefined) throw new Error("Invalid new-sense decision");
      validateReviewedRows([{ word: entry.word, list_id: "List 01", cefr: entry.cefr, senses: [d.sense], irregular_forms: entry.irregular_forms }]);
      if (entry.senses.some(s => senseKey(s) === senseKey(d.sense!))) throw new Error("Sense already exists; use reuse, never overwrite its example");
      const list = additions.get(entry.entry_id) ?? [];
      const same = list.find(s => senseKey(s) === senseKey(d.sense!));
      if (same && digest(same) !== digest(d.sense)) throw new Error("Conflicting examples for repeated new sense; confirm one shared sense");
      if (!same) list.push(d.sense);
      additions.set(entry.entry_id, list);
    } else if (d.action === "new") {
      const word = newWords.get(d.base_form);
      if (entry || !word || !Number.isInteger(d.sense_index) || !word.senses[d.sense_index!] || d.sense !== undefined) throw new Error("Invalid new-word sense reference");
      referenced.add(`${norm(word.word)}:${d.sense_index}`);
    } else throw new Error("Unknown decision action");
  }
  for (const word of review.new_words) word.senses.forEach((_, i) => {
    if (!referenced.has(`${norm(word.word)}:${i}`)) throw new Error("New word/sense has no CTW correct-answer provenance");
  });
  const entries = [...plan.snapshot.entries], memberships = [...plan.snapshot.memberships];
  const newEntries: EntryRow[] = [], newMemberships: Membership[] = [];
  // Stable reviewer order for new words, never reshuffle old words or rerun initial balancing.
  for (const w of review.new_words) {
    const index = entries.length;
    const e: EntryRow = { entry_id: deterministicId(norm(w.word)), word: w.word, normalized_word: w.word.toLowerCase(),
      list_number: Math.floor(index / 50) + 1, list_position: index % 50 + 1, cefr: w.cefr,
      senses: structuredClone(w.senses), irregular_forms: structuredClone(w.irregular_forms), source_sha256: digest(review) };
    if (entries.some(old => old.entry_id === e.entry_id)) throw new Error("Deterministic entry ID collision");
    const group = cefrGroup(w.cefr), n = memberships.filter(m => m.cefr_group === group).length;
    const m: Membership = { entry_id: e.entry_id, cefr_group: group, list_number: Math.floor(n / 50) + 1, list_position: n % 50 + 1 };
    entries.push(e); memberships.push(m); newEntries.push(e); newMemberships.push(m);
  }
  const senses = Array.from(additions, ([id, added]) => {
    const e = plan.snapshot.entries.find(e => e.entry_id === id)!;
    if (e.senses.length + added.length > 100) throw new Error("Sense limit exceeded");
    return { entry_id: id, word: e.word, senses: added };
  });
  return { version: "ctw-incremental-publication-v1", plan, review, reuse, senses, new_entries: newEntries, memberships: newMemberships,
    next_checkpoint: { version: "ctw-incremental-checkpoint-v1", sources: plan.sources } };
}

export function verifyCtw(publication: CtwPublication, live: CtwSnapshot, requireApplied = false) {
  if (digest(prepareCtw(publication.plan, publication.review)) !== digest(publication)) throw new Error("Publication does not reproduce from reviewed inputs");
  if (digest(canonicalSources(live.canonical)) !== digest(publication.plan.sources)) throw new Error("Canonical drift; original plan preserved");
  validateSnapshot(live);
  const before = publication.plan.snapshot;
  const afterEntries = before.entries.map(e => ({ ...e, senses: [...e.senses, ...(publication.senses.find(s => s.entry_id === e.entry_id)?.senses ?? [])] })).concat(publication.new_entries);
  const sameRows = (a: unknown[], b: unknown[]) => digest(a.map(digest).sort()) === digest(b.map(digest).sort());
  const applied = sameRows(live.entries, afterEntries) && sameRows(live.memberships, before.memberships.concat(publication.memberships));
  const fresh = sameRows(live.entries, before.entries) && sameRows(live.memberships, before.memberships);
  if (!applied && (!fresh || requireApplied)) throw new Error("CTW baseline/post-state drift or partial import; no automatic reconciliation");
  return { state: applied ? "applied" as const : "fresh" as const, verified: true, production_writes: 0 };
}
