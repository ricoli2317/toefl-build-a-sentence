import type { WordbookDomain } from "./wordbookList.ts";
import type { ReviewExamplePart } from "./wordbookReviewPresentation.ts";

export const REVIEW_SOURCES = {
  reading: [{ id: "ctw", label: "CTW" }, { id: "rdl", label: "RDL" }, { id: "rap", label: "RAP" }],
  writing: [{ id: "bas", label: "BAS" }, { id: "write_email", label: "WE" }, { id: "academic_discussion", label: "AD" }]
} as const;
export const REVIEW_REASON_LABELS: Record<string, string> = {
  missing_source_sense: "缺少准确来源—义项证据", missing_reliable_meaning: "缺少可靠中文语境义",
  missing_reliable_pos: "缺少有效词性", insufficient_distractors: "不足三个合格干扰项", answer_in_prompt: "语境义中包含答案提示"
};
export type ReviewSettings = { domain: WordbookDomain; sources: string[]; mode: "date" | "range" | "random";
  timeZone: string; start?: string; end?: string; count?: number };
export type ReviewOption = { id: string; label?: string; text?: string };
export type ReviewAnswer = { student: { spelling?: string; pos?: string; optionId?: string }; assessments: Record<string, boolean>;
  correct: boolean; submittedAt: string; expression: string; pos: string | null; standardPos: string | null;
  meaning: string; definitionEn: string | null; correctOptionId: string | null; examples: { text: string; kind: string }[] };
export type ReviewItem = { itemId: string; position: number; kind: "spelling_pos" | "meaning_choice";
  sourceTypes: string[]; prompt: string; options: ReviewOption[]; answer?: ReviewAnswer;
  spellingShape?: string; example?: ReviewExamplePart[] | null;
  study?: { expression: string; pos: string | null; meaning: string } };
export type ReviewSummary = { correct: number; incorrect: number; spellingCorrect: number; spellingTotal: number;
  posCorrect: number; posTotal: number; choiceCorrect: number; choiceTotal: number };
export type ReviewSession = { session_id: string; domain: WordbookDomain; source_types: string[]; mode: ReviewSettings["mode"] | "retry";
  settings: Partial<ReviewSettings>; timezone: string; started_at: string; completed_at: string | null;
  status: "active" | "completed"; total: number; answered: number; parent_session_id: string | null };
export type ReviewState = { session: ReviewSession; summary: ReviewSummary; composition: { spellingPos: number; meaningChoice: number }; item: ReviewItem;
  flow?: { phase: "study" | "test" | "result"; position: number } };
// Authorized review clients deliberately receive the fixed round's answers.
// This is vocabulary practice, not an examination or an anti-cheating boundary.
export type ReviewCard = ReviewItem & { expected: { expression: string; pos: string | null; standardPos: string | null;
  meaning: string; definitionEn: string | null; correctOptionId: string | null; examples: { text: string; kind: string }[] };
  targetForms: string[] };
export type ReviewRound = ReviewState & { cards: ReviewCard[] };
export type ReviewCommand = { id: string; action: "study_next" | "repeat" | "start_test" | "answer" | "advance";
  itemId: string; answer?: ReviewAnswer["student"] };
export type ReviewAvailability = { total: number; spellingPos: number; meaningChoice: number; unavailable: number;
  reasons: Record<string, number>; posOptions: ReviewOption[] };
export type ReviewHistory = { items: (ReviewSession & { summary: ReviewSummary })[]; total: number; page: number; pageSize: number };
export type ReviewErrors = { items: ReviewItem[]; total: number; page: number; pageSize: number };
export class ReviewError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) { super(message); this.code = code; this.status = status; }
}
const invalid = () => new ReviewError("REVIEW_INVALID", 400, "无效的复习参数。");
export function reviewUuid(value: unknown) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw invalid();
  return value;
}
export function reviewObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw invalid();
  return value as Record<string, unknown>;
}
export function parseReviewSettings(value: unknown): ReviewSettings {
  const v = reviewObject(value, ["domain", "sources", "mode", "timeZone", "start", "end", "count"]);
  if (v.domain !== "reading" && v.domain !== "writing" || !Array.isArray(v.sources) || !v.sources.length
    || new Set(v.sources).size !== v.sources.length || v.sources.some(s => !REVIEW_SOURCES[v.domain as WordbookDomain].some(t => t.id === s))
    || typeof v.timeZone !== "string" || !["date", "range", "random"].includes(String(v.mode))) throw invalid();
  try { new Intl.DateTimeFormat("en", { timeZone: v.timeZone }); } catch { throw invalid(); }
  if (v.mode === "random") {
    if (v.start !== undefined || v.end !== undefined || !Number.isSafeInteger(v.count) || Number(v.count) < 1 || Number(v.count) > 999999) throw invalid();
  } else if (v.count !== undefined || typeof v.start !== "string" || typeof v.end !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(v.start) || !/^\d{4}-\d{2}-\d{2}$/.test(v.end)) throw invalid();
  // The database independently validates real dates, July/today bounds and local timezone boundaries.
  return { ...v, sources: [...v.sources].sort() } as ReviewSettings;
}
export function reviewPage(value: string | null) {
  if (value !== null && (!/^[1-9]\d*$/.test(value) || Number(value) > 100000)) throw invalid();
  return value === null ? 1 : Number(value);
}
export function reviewRangeLabel(session: ReviewSession) {
  return session.mode === "retry" ? "错词再练" : session.mode === "random" ? `随机 ${session.total} 个`
    : session.mode === "date" ? session.settings.start : `${session.settings.start} — ${session.settings.end}`;
}
export function reviewPercent(correct: number, total: number) { return total ? `${Math.round(correct / total * 100)}%` : "—"; }
