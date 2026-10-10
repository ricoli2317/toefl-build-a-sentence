import type { ReviewAnswer, ReviewCommand, ReviewRound, ReviewState, ReviewSummary } from "./wordbookReview.ts";
import { reviewExample, spellingShape } from "./wordbookReviewPresentation.ts";

export type LocalReview = { version: 1; owner: string; round: ReviewRound; phase: "study" | "test" | "result";
  position: number; answers: Record<string, ReviewAnswer>; deadlines: Record<string, number>;
  queue: ReviewCommand[]; confirmed: number; revision: number;
  syncFailure?: { count: number; message: string; detail: string; requiresIntervention: boolean } };
// Matches Postgres wordbook_review_spelling: collapse POSIX whitespace, btrim
// ASCII space, lowercase. Do NOT normalize punctuation, apostrophes or NFKC.
export const normalizeReviewSpelling = (text: string) => Array.from(text
  .replace(/[\t\n\v\f\r \u0085\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]+/g, " ")
  .replace(/^ +| +$/g, ""))
  // PostgreSQL simple Unicode lowercase is per-character: no contextual final
  // sigma or JS's multi-codepoint dotted-I expansion.
  .map(char => char === "İ" ? "i" : char.toLowerCase()).join("");
export function gradeReview(card: ReviewRound["cards"][number], student: ReviewAnswer["student"], at = new Date().toISOString()): ReviewAnswer {
  const e = card.expected;
  const assessments: Record<string, boolean> = card.kind === "spelling_pos"
    ? { spelling: normalizeReviewSpelling(student.spelling ?? "") === normalizeReviewSpelling(e.expression), pos: student.pos === e.pos }
    : { meaning_choice: student.optionId === e.correctOptionId };
  return { ...e, student, assessments, correct: Object.values(assessments).every(Boolean), submittedAt: at };
}
export function localReview(owner: string, round: ReviewRound): LocalReview {
  return { version: 1, owner, round, phase: round.session.status === "completed" && round.flow?.phase === "study" ? "result"
      : round.flow?.phase ?? (round.session.status === "completed" ? "result" : "study"),
    position: round.flow?.position ?? 1, answers: Object.fromEntries(round.cards.filter(c => c.answer).map(c => [c.itemId, c.answer!])),
    deadlines: {}, queue: [], confirmed: round.session.answered, revision: 0 };
}
export function reviewLocalState(local: LocalReview): ReviewState {
  const card = local.round.cards[local.position - 1], e = card.expected;
  const summary: ReviewSummary = { correct: 0, incorrect: 0, spellingCorrect: 0, spellingTotal: 0, posCorrect: 0, posTotal: 0, choiceCorrect: 0, choiceTotal: 0 };
  for (const c of local.round.cards) {
    const a = local.answers[c.itemId]; if (!a) continue;
    summary[a.correct ? "correct" : "incorrect"]++;
    if (c.kind === "spelling_pos") { summary.spellingTotal++; summary.posTotal++; summary.spellingCorrect += Number(a.assessments.spelling); summary.posCorrect += Number(a.assessments.pos); }
    else { summary.choiceTotal++; summary.choiceCorrect += Number(a.assessments.meaning_choice); }
  }
  const study = local.phase === "study";
  const example = [...e.examples].sort((a, b) => Number(b.kind === "sentence") - Number(a.kind === "sentence"))
    .map(ex => reviewExample(ex.text, e.expression, !study && card.kind === "spelling_pos", card.targetForms)).find(Boolean) ?? null;
  return { session: { ...local.round.session, answered: Object.keys(local.answers).length,
      status: local.phase === "result" ? "completed" : "active" }, summary, composition: local.round.composition,
    flow: { phase: local.phase, position: local.position }, item: { ...card, example, spellingShape: spellingShape(e.expression),
      answer: study ? undefined : local.answers[card.itemId], ...(study ? { study: { expression: e.expression, pos: e.standardPos, meaning: e.meaning } } : {}) } };
}
/** Pure local transition; command IDs are assigned before durable publication. */
export function applyReviewAction(local: LocalReview, command: ReviewCommand, clickedAt = Date.now()): LocalReview {
  const card = local.round.cards[local.position - 1];
  if (command.itemId !== card.itemId || local.phase === "result") return local;
  let next = { ...local, revision: local.revision + 1, queue: [...local.queue, command] };
  switch (command.action) {
    case "study_next": if (local.phase !== "study" || local.position === local.round.cards.length) return local; next.position++; break;
    case "repeat": if (local.phase !== "study" || local.position !== local.round.cards.length) return local; next.position = 1; break;
    case "start_test": if (local.phase !== "study") return local; next.phase = "test"; next.position = Math.min(local.round.cards.length, Object.keys(local.answers).length + 1); break;
    case "answer": {
      if (local.phase !== "test" || local.answers[card.itemId] || !command.answer) return local;
      const answer = gradeReview(card, command.answer);
      next.answers = { ...local.answers, [card.itemId]: answer };
      if (answer.correct) next.deadlines = { ...local.deadlines, [card.itemId]: clickedAt + 1000 };
      break;
    }
    case "advance":
      if (local.phase !== "test" || !local.answers[card.itemId]) return local;
      if (local.answers[card.itemId].correct && (local.deadlines[card.itemId] ?? 0) > clickedAt) return local;
      if (local.position === local.round.cards.length) next.phase = "result"; else next.position++;
      break;
  }
  return next;
}
export const localReviewKey = (owner: string, session: string) => `tps:wordbook-review:pending:${owner}:${session}`;
export function readLocalReview(storage: Pick<Storage, "getItem">, owner: string, session: string): LocalReview | null {
  const raw = storage.getItem(localReviewKey(owner, session)); if (!raw) return null;
  let value: LocalReview;
  try { value = JSON.parse(raw) as LocalReview; }
  catch { throw new Error("本地待同步记录无法读取，请勿清除浏览器数据，稍后重试。"); }
  if (!value || value.version !== 1 || value.owner !== owner || value.round?.session?.session_id !== session || !Array.isArray(value.queue)
    || !Array.isArray(value.round.cards) || value.position < 1 || value.position > value.round.cards.length) throw new Error("本地待同步记录无法读取，请勿清除浏览器数据，稍后重试。");
  return value;
}
export function saveLocalReview(storage: Pick<Storage, "setItem">, value: LocalReview) {
  try { storage.setItem(localReviewKey(value.owner, value.round.session.session_id), JSON.stringify(value)); }
  catch { throw new Error("浏览器无法保存待同步记录（空间不足或存储被禁用）。本次操作未确认，请恢复存储后重试。"); }
}
export function acknowledgeReview(local: LocalReview, command: ReviewCommand): LocalReview {
  if (!local.queue.some(c => c.id === command.id)) return local;
  return { ...local, queue: local.queue.filter(c => c.id !== command.id), confirmed: local.confirmed + Number(command.action === "answer"), syncFailure: undefined };
}
export function recordReviewSyncFailure(local: LocalReview, message: string, retryable: boolean, detail = message): LocalReview {
  return { ...local, syncFailure: { count: (local.syncFailure?.count ?? 0) + 1, message, detail, requiresIntervention: !retryable } };
}
export function visibleReviewSyncError(local?: LocalReview) {
  // Initial failure + retries 1 and 2 remain silent. Retry 3 failing is the
  // fourth consecutive failure. This threshold also applies to auth/conflict
  // errors; their retries are bounded instead of looping indefinitely.
  return local?.queue.length && local.syncFailure && local.syncFailure.count > 3
    ? local.syncFailure.message : "";
}
