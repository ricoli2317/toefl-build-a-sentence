import type { ReadingCorrectionAnswerPresentation, ReadingCorrectionResultPayload } from "./correctionResult.ts";
import type { ReadingAnswerState } from "./practiceState.ts";
import type { SubmittedReadingAnswerRow, SubmittedReadingReviewItem } from "./review.ts";
import { buildSubmittedReadingAnswerState, buildSubmittedReadingReviewItems } from "./review.ts";
import type { WrongQuestionPracticeSession, WrongQuestionSessionGroup } from "../wrongQuestionBank.ts";
import type { ReadingModule } from "./types.ts";
import type { CategorySessionPayload } from "./questionCategory.ts";
import { categoryAnswerRows, categorySessionTitle } from "./questionCategory.ts";
import { buildReadingWrongbookSessionReviewPayload } from "./wrongbookSession.ts";
import { selectReadingTargetPractice, selectReadingWrongbookPractice, type ReadingWrongbookContextAnswer } from "./wrongbook.ts";
import { readReadingSessionPractice, readReadingSessionCache } from "./sessionExperience.ts";
import type { StudentReadingPracticePayload } from "./studentPractice.ts";

export type ReadingSessionReviewSource = {
  group: WrongQuestionSessionGroup;
  practiceCacheKey: string;
  attempt: { attemptId: string; elapsedSeconds: number };
  answers: ReadingAnswerState;
  reviewItems: SubmittedReadingReviewItem[];
  disclosures: Record<string, ReadingCorrectionAnswerPresentation>;
};
/** Immutable completed metadata only. Large material payloads stay in their
 * existing shared practice keys, never serialized into a second collection. */
export type ReadingSessionReviewBundle = {
  kind: "category" | "wrongbook";
  sessionId: string;
  title: string;
  taskType: ReadingModule;
  elapsedSeconds: number;
  sources: ReadingSessionReviewSource[];
};
export type WrongbookReviewResult = ReadingCorrectionResultPayload & {
  review: {
    correctionRows: SubmittedReadingAnswerRow[];
    preservedRows: SubmittedReadingAnswerRow[];
    contextAnswers: ReadingWrongbookContextAnswer[];
    disclosures: Record<string, ReadingCorrectionAnswerPresentation>;
  };
};
export type CategoryCompletedReview = CategorySessionPayload & { bundle: ReadingSessionReviewBundle };
export type WrongbookCompletedReview = { session: WrongQuestionPracticeSession;
  results: Array<{ group: WrongQuestionSessionGroup; payload: WrongbookReviewResult }>;
  bundle: ReadingSessionReviewBundle };
export type ReadingReviewAuth = { studentId: string; accessToken: string };
export type ReadingReviewCache = {
  getEntry: (key: string) => { status: string; data?: unknown } | undefined;
  load: <T>(key: string, loader: (auth: ReadingReviewAuth) => Promise<T>) => Promise<T | undefined>;
  setData: <T>(key: string, data: T) => void;
};
export const sessionReviewBundleCacheKey = (kind: ReadingSessionReviewBundle["kind"], id: string) => `reading:session-review-bundle:${kind}:${id}`;
export const sessionReviewPracticeCacheKey = (kind: ReadingSessionReviewBundle["kind"], id: string) => kind === "category"
  ? `reading:category-content:${id}` : `wrong-questions:reading-correction-practice:${id}`;

async function request<T>(url: string, auth: ReadingReviewAuth): Promise<T> {
  const response = await fetch(url, { cache: "no-store", headers: { Authorization: `Bearer ${auth.accessToken}` } });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error ?? "练习结果加载失败，请稍后重试。");
  return payload as T;
}

async function ensurePractice(cache: ReadingReviewCache, kind: ReadingSessionReviewBundle["kind"], itemId: string) {
  const key = sessionReviewPracticeCacheKey(kind, itemId);
  const cached = readReadingSessionPractice(cache, key);
  if (cached) return cached;
  const loaded = await cache.load(key, async (auth) => {
    const payload = await request<{ practice: StudentReadingPracticePayload }>(`/api/reading/practice/${encodeURIComponent(itemId)}`, auth);
    if (payload.practice?.item.itemId !== itemId) throw new Error("阅读材料数据无效。");
    return payload;
  });
  if (!loaded?.practice) throw new Error("阅读材料加载失败，请稍后重试。");
  return loaded.practice;
}

/** Also handles independent material eviction while completed metadata survives.
 * No alternate answer assembly and no metadata refetch are needed. */
export async function restoreSessionReviewMaterials(bundle: ReadingSessionReviewBundle, cache: ReadingReviewCache) {
  await Promise.all(bundle.sources.map((source) => ensurePractice(cache, bundle.kind, source.group.logicalItemId)));
}

function sourceMetadata(input: { group: WrongQuestionSessionGroup; practice: StudentReadingPracticePayload;
  kind: ReadingSessionReviewBundle["kind"]; attemptId: string; elapsedSeconds: number;
  rows: SubmittedReadingAnswerRow[]; preservedRows?: SubmittedReadingAnswerRow[];
  contextAnswers?: ReadingWrongbookContextAnswer[]; disclosures: Record<string, ReadingCorrectionAnswerPresentation> }) {
  const practice = input.kind === "category" ? selectReadingTargetPractice(input.practice, input.group.targets)
    : selectReadingWrongbookPractice(input.practice, input.group.targets);
  const reviewItems = buildSubmittedReadingReviewItems(practice, input.rows);
  if (reviewItems.length !== input.group.targets.length || reviewItems.some((item) => !input.disclosures[item.answerId])) {
    throw new Error("练习作答详情不完整，请重试。");
  }
  return { group: input.group, practiceCacheKey: sessionReviewPracticeCacheKey(input.kind, input.group.logicalItemId),
    attempt: { attemptId: input.attemptId, elapsedSeconds: input.elapsedSeconds },
    answers: buildSubmittedReadingAnswerState(practice, [...input.rows, ...(input.preservedRows ?? [])],
      { tolerateMissingCtwSlots: input.kind === "wrongbook", contextAnswers: input.contextAnswers }),
    disclosures: input.disclosures, reviewItems } satisfies ReadingSessionReviewSource;
}

/** The same loader serves result hydration AND hard-refresh recovery. The cache
 * coalesces concurrent callers; after completion review navigation is local. */
export async function loadCategoryCompletedReview(id: string, cache: ReadingReviewCache, auth: ReadingReviewAuth): Promise<CategoryCompletedReview> {
  const data = await request<CategorySessionPayload & { disclosures: Record<string, ReadingCorrectionAnswerPresentation> }>(
    `/api/reading/question-category/sessions/${encodeURIComponent(id)}?review=1`, auth);
  if (data.session.sessionId !== id || data.session.status !== "completed") throw new Error("这次练习还没有完成。");
  const sources = await Promise.all(data.session.groups.map(async (group) => sourceMetadata({
    kind: "category", group, practice: await ensurePractice(cache, "category", group.logicalItemId),
    attemptId: id, elapsedSeconds: data.session.progress[group.logicalItemId].elapsedSeconds,
    rows: categoryAnswerRows(data.answers.filter((answer) => answer.logicalItemId === group.logicalItemId)), disclosures: data.disclosures
  })));
  cache.setData(`reading:category-session:${id}`, { session: data.session, answers: data.answers });
  return { session: data.session, answers: data.answers, bundle: { kind: "category", sessionId: id,
    title: categorySessionTitle(data.session.questionCategory), taskType: "rap", elapsedSeconds: data.session.elapsedSeconds, sources } };
}

export async function loadWrongbookCompletedReview(id: string, cache: ReadingReviewCache, auth: ReadingReviewAuth,
  knownSession?: WrongQuestionPracticeSession): Promise<WrongbookCompletedReview> {
  const sessionKey = `wrong-questions:reading-bank-result:${id}`;
  const session = knownSession ?? readReadingSessionCache<{ session: WrongQuestionPracticeSession }>(cache, sessionKey)?.session
    ?? (await request<{ session: WrongQuestionPracticeSession }>(`/api/wrong-questions/sessions/${encodeURIComponent(id)}`, auth)).session;
  if (session.sessionId !== id || session.taskType === "bas" || session.status !== "completed"
    || !session.groups?.length || session.groups.some((group) => !session.progress[group.logicalItemId])) throw new Error("这次练习还没有完成。");
  const results = await Promise.all(session.groups.map(async (group) => {
    const payload = await request<WrongbookReviewResult>(`/api/reading/wrongbook-attempts/${encodeURIComponent(session.progress[group.logicalItemId].attemptId)}/result?review=1`, auth);
    if (!payload.review || payload.attempt.attemptId !== session.progress[group.logicalItemId].attemptId) throw new Error("订正作答详情不完整，请重试。");
    return { group, payload };
  }));
  const sources = await Promise.all(results.map(async ({ group, payload }) => sourceMetadata({
    kind: "wrongbook", group, practice: await ensurePractice(cache, "wrongbook", group.logicalItemId),
    attemptId: payload.attempt.attemptId, elapsedSeconds: payload.attempt.elapsedSeconds,
    rows: payload.review.correctionRows, preservedRows: payload.review.preservedRows,
    contextAnswers: payload.review.contextAnswers, disclosures: payload.review.disclosures
  })));
  cache.setData(sessionKey, { session });
  return { session, results, bundle: { kind: "wrongbook", sessionId: id, title: session.mode === "today" ? "今日错题订正" : "历史错题练习",
    taskType: session.taskType, elapsedSeconds: session.elapsedSeconds ?? results.reduce((n, result) => n + result.payload.attempt.elapsedSeconds, 0), sources } };
}

export function resolveSessionReviewBundle(bundle: ReadingSessionReviewBundle, cache: Pick<ReadingReviewCache, "getEntry">,
  reviewHref: (index: number) => string) {
  const groupReviews = bundle.sources.map((source) => {
    const cached = readReadingSessionPractice(cache, source.practiceCacheKey);
    if (!cached) throw new Error("练习材料缓存已丢失，请刷新恢复。");
    const practice = bundle.kind === "category" ? selectReadingTargetPractice(cached, source.group.targets)
      : selectReadingWrongbookPractice(cached, source.group.targets);
    return { group: source.group, payload: { ...source, practice } };
  });
  return buildReadingWrongbookSessionReviewPayload({ groupReviews, reviewHref, sessionId: bundle.sessionId,
    title: bundle.title, taskType: bundle.taskType, totalElapsedSeconds: bundle.elapsedSeconds });
}
