import { gradeVocabularySpelling, type AttemptResult, type AttemptSubmission, type GradedAnswer,
  type IrregularFormType, type RoundSource, type SpellingAnswer, type VocabularyEntry, type VocabularySense } from "./model.ts";
import { spellingShape } from "../lexical/wordbookReviewPresentation.ts";
import { spellingLetterLimit } from "../lexical/wordbookReviewInput.ts";
import { parseAttemptSubmission, parseRoundSource, UUID_PATTERN } from "./input.ts";

export const VOCABULARY_ROOT = "/student/ctw-vocabulary";
export const VOCABULARY_API = "/api/student/ctw-vocabulary";
export const POS_LABELS: Record<VocabularySense["pos"], string> = {
  noun: "n.", verb: "v.", adjective: "adj.", adverb: "adv.", preposition: "prep.",
  determiner: "det.", pronoun: "pron.", conjunction: "conj.", particle: "part.", numeral: "num."
};
export const FORM_LABELS: Record<IrregularFormType, string> = {
  past: "过去式", past_participle: "过去分词", plural: "复数", comparative: "比较级", superlative: "最高级",
  present_third_person_singular: "一般现在时第三人称单数", present_first_person_singular: "现在时第一人称单数",
  present_second_person_or_plural: "现在时第二人称或复数", past_first_or_third_person_singular: "过去时第一或第三人称单数",
  past_second_person_or_plural: "过去时第二人称或复数", past_modal: "情态动词过去式"
};
export const listLabel = (number: number) => `List ${String(number).padStart(2, "0")}`;
export const sourceReturnHref = (source?: RoundSource) => source?.kind === "cefr_list" || source?.kind === "cefr" ? `${VOCABULARY_ROOT}?tab=cefr` : VOCABULARY_ROOT;
/** Shape only: the original native input handles all editing and fixed spaces. */
export function vocabularySpellingShape(answers: string[]) {
  const longest = answers.reduce((a, b) => spellingLetterLimit(a) >= spellingLetterLimit(b) ? a : b, "");
  return spellingShape(longest);
}
export function assessVocabularyEntry(entry: VocabularyEntry, answer: SpellingAnswer) {
  const baseCorrect = gradeVocabularySpelling(entry, "base_form", answer.spelling);
  const forms = entry.irregular_forms.map(form => {
    const spelling = answer.irregularSpellings?.find(a => a.formType === form.form_type)?.spelling ?? "";
    return { formType: form.form_type, spelling, acceptedAnswers: form.answers,
      correct: gradeVocabularySpelling(entry, "irregular", spelling, form.form_type) };
  });
  return { baseCorrect, forms, correct: baseCorrect && forms.every(form => form.correct) };
}
export type LocalVocabularyRound = {
  version: 1; owner: string; attemptId: string; source: RoundSource; entries: VocabularyEntry[];
  phase: "study" | "test" | "saving" | "saved"; index: number; answers: SpellingAnswer[];
  draft: SpellingAnswer; result?: AttemptResult;
};
export const roundKey = (owner: string, id: string) => `tps:ctw-vocabulary:v1:${owner}:${id}`;
export const emptyVocabularyAnswer = (entry: VocabularyEntry): SpellingAnswer => ({ entryId: entry.entry_id, spelling: "",
  irregularSpellings: entry.irregular_forms.map(form => ({ formType: form.form_type, spelling: "" })) });
export function createVocabularyRound(owner: string, attemptId: string, source: RoundSource, entries: VocabularyEntry[]): LocalVocabularyRound {
  if (!entries.length || entries.length > 200 || new Set(entries.map(e => e.entry_id)).size !== entries.length) throw new Error("词条集合无效，请重新开始。");
  return { version: 1, owner, attemptId, source, entries, phase: "study", index: 0, answers: [], draft: emptyVocabularyAnswer(entries[0]) };
}
export function writeVocabularyRound(storage: Pick<Storage, "setItem">, round: LocalVocabularyRound) {
  storage.setItem(roundKey(round.owner, round.attemptId), JSON.stringify(round));
}
export function readVocabularyRound(storage: Pick<Storage, "getItem">, owner: string, id: string): LocalVocabularyRound | null {
  const raw = storage.getItem(roundKey(owner, id));
  if (!raw) return null;
  const round = JSON.parse(raw) as LocalVocabularyRound;
  if (round.version !== 1 || round.owner !== owner || round.attemptId !== id || !Array.isArray(round.entries)
    || !round.entries.length || round.entries.length > 200 || !Array.isArray(round.answers)
    || !Number.isInteger(round.index) || round.index < 0 || round.index >= round.entries.length
    || !["study", "test", "saving", "saved"].includes(round.phase) || !round.draft
    || (round.phase === "saving" && round.answers.length !== round.entries.length)
    || (round.phase === "saved" && round.result?.attempt_id !== id)) throw new Error("本机进度无法读取；不会覆盖记录，请尝试刷新或查看测试历史。");
  parseRoundSource(round.source);
  if (new Set(round.entries.map(entry => entry.entry_id)).size !== round.entries.length
    || round.entries.some(entry => !UUID_PATTERN.test(entry.entry_id) || typeof entry.word !== "string"
      || !Array.isArray(entry.senses) || !Array.isArray(entry.irregular_forms))
    || round.answers.length > round.entries.length
    || round.answers.some((answer, index) => answer.entryId !== round.entries[index].entry_id)
    || (round.phase === "test" && ![round.index, round.index + 1].includes(round.answers.length))
    || (round.phase === "test" && round.draft.entryId !== round.entries[round.index].entry_id))
    throw new Error("本机进度结构无效；不会覆盖记录，请查看测试历史或刷新重试。");
  if (round.answers.length) parseAttemptSubmission({ attemptId: id, mode: "base_form", source: round.source, answers: round.answers });
  parseAttemptSubmission({ attemptId: id, mode: "base_form", source: round.source, answers: [round.draft] });
  return round;
}
export function vocabularySubmission(round: LocalVocabularyRound): AttemptSubmission {
  if (round.answers.length !== round.entries.length) throw new Error("本轮尚未答完。");
  return { attemptId: round.attemptId, mode: "base_form", source: round.source, answers: round.answers };
}
export function vocabularyResultGroups(result: AttemptResult) {
  const groups = new Map<string, GradedAnswer[]>();
  for (const answer of result.answers) groups.set(answer.entryId, [...(groups.get(answer.entryId) ?? []), answer]);
  return Array.from(groups.values()).map(answers => ({ entryId: answers[0].entryId, word: answers[0].word,
    senses: answers[0].senses, correct: answers.every(a => a.correct), answers }));
}
