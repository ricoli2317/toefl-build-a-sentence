import type { AttemptResult, IrregularFormType, RoundSource, SpellingAnswer, VocabularyEntry, VocabularySense } from "./model.ts";
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
  past: "过去时", past_participle: "过去分词", plural: "复数", comparative: "比较级", superlative: "最高级",
  present_third_person_singular: "第三人称单数", present_first_person_singular: "现在时",
  present_second_person_or_plural: "现在时", past_first_or_third_person_singular: "过去时",
  past_second_person_or_plural: "过去时", past_modal: "过去时"
};
export const listLabel = (number: number) => `List ${String(number).padStart(2, "0")}`;
export const sourceReturnHref = (source?: RoundSource) => source?.kind === "cefr_list" || source?.kind === "cefr" ? `${VOCABULARY_ROOT}?tab=cefr` : VOCABULARY_ROOT;
/** Shape only: the original native input handles all editing and fixed spaces. */
export function vocabularySpellingShape(answers: string[]) {
  const longest = answers.reduce((a, b) => spellingLetterLimit(a) >= spellingLetterLimit(b) ? a : b, "");
  return spellingShape(longest);
}
// Read-only v1 compatibility below. New rounds use Wordbook's LocalReview,
// command queue, acknowledgements and storage, never this old batch flow.
export type LocalVocabularyRound = {
  version: 1; owner: string; attemptId: string; source: RoundSource; entries: VocabularyEntry[];
  phase: "study" | "test" | "saving" | "saved"; index: number; answers: SpellingAnswer[];
  draft: SpellingAnswer; result?: AttemptResult;
};
export const roundKey = (owner: string, id: string) => `tps:ctw-vocabulary:v1:${owner}:${id}`;
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
