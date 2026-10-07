"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useStudentCachedData, useStudentDataCache, STUDENT_PRACTICE_HISTORY_CACHE_PREFIX, STUDENT_DASHBOARD_SUMMARY_CACHE_KEY } from "@/components/StudentDataCache";
import { ReadingMultiSourceSessionRunner, ReadingSessionMessage, type ReadingSessionAdapter } from "./ReadingMultiSourceSessionRunner";
import {
  CATEGORY_API, CATEGORY_ROUTE, categoryAnswerRows, categoryResultHref, categorySessionTitle,
  type CategorySession, type CategorySessionPayload, type CategorySubmitPayload, type CategoryDraft,
  type ReadingQuestionCategory
} from "@/lib/reading/questionCategory";
import { categoryFetch, categoryGroupUrl, categoryPracticeCacheKey, categorySessionCacheKey, loadCategorySession } from "@/lib/reading/questionCategory.client";
import { buildSubmittedReadingAnswerState } from "@/lib/reading/review";
import { invalidateStudentWrongbook } from "@/lib/studentCacheEvents";
import type { WrongQuestionSessionGroup } from "@/lib/wrongQuestionBank";
import type { ReadingAttemptSummary } from "@/lib/reading/attempts";

const creations = new Map<string, Promise<CategorySessionPayload>>();
const draftKey = (studentId: string, id: string, itemId: string) => `tps:category-draft:${studentId}:${id}:${itemId}`;

/** Renderer metadata only; NO attempt is inserted or submitted for a category source. */
export function categorySourceSummary(session: CategorySession, group: WrongQuestionSessionGroup): ReadingAttemptSummary {
  const progress = session.progress[group.logicalItemId];
  return {
    attemptId: session.sessionId, logicalItemId: group.logicalItemId, taskType: "rap",
    status: progress ? "submitted" : "draft", startedAt: session.createdAt,
    submittedAt: progress?.submittedAt ?? null, elapsedSeconds: progress?.elapsedSeconds ?? 0,
    totalPoints: progress?.totalPoints ?? group.targets.length, correctPoints: progress?.correctPoints ?? 0,
    incorrectPoints: 0, unansweredPoints: 0
  };
}

export function QuestionCategoryPractice({ questionCategory, amount, sessionId }: {
  questionCategory?: ReadingQuestionCategory; amount?: 5 | 10 | 15 | 20; sessionId?: string;
}) {
  const router = useRouter();
  const cache = useStudentDataCache();
  const cacheRef = useRef(cache); cacheRef.current = cache;
  const [pinned, setPinned] = useState(sessionId ?? "");
  const [saveError, setSaveError] = useState("");
  const [nonce] = useState(() => `${Date.now()}-${Math.random()}`);
  const key = `reading:category-entry:${pinned || "create"}:${nonce}`;
  const state = useStudentCachedData<CategorySessionPayload>(key, async (auth) => {
    if (pinned) return loadCategorySession(pinned, auth);
    const creationKey = `${auth.studentId}:${nonce}`;
    let request = creations.get(creationKey);
    if (!request) {
      request = categoryFetch<CategorySessionPayload>(CATEGORY_API, auth, { questionCategory, amount })
        .finally(() => creations.delete(creationKey));
      creations.set(creationKey, request);
    }
    return request;
  }, { refreshOnMount: Boolean(sessionId) });
  const practiceSession = state.data?.session;
  const sessionRef = useRef(state.data); sessionRef.current = state.data;
  useEffect(() => {
    if (!practiceSession || pinned) return;
    cacheRef.current.setData(categorySessionCacheKey(practiceSession.sessionId), state.data);
    cacheRef.current.setData(`reading:category-entry:${practiceSession.sessionId}:${nonce}`, state.data);
    setPinned(practiceSession.sessionId);
    const url = new URL(window.location.href);
    url.searchParams.set("session", practiceSession.sessionId);
    window.history.replaceState(null, "", url.toString());
  }, [nonce, pinned, practiceSession, state.data]);
  useEffect(() => {
    if (practiceSession?.status === "completed") router.replace(categoryResultHref(practiceSession.sessionId));
  }, [practiceSession, router]);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);
  const adapter = useMemo<ReadingSessionAdapter>(() => ({
    sourceCacheKey: (id, itemId) => `reading:category-source:${id}:${itemId}:${nonce}`,
    practiceCacheKey: categoryPracticeCacheKey,
    loadSource: async (id, group, auth) => {
      const payload = sessionRef.current ?? await loadCategorySession(id, auth);
      const session = payload.session;
      const rows = categoryAnswerRows(payload.answers.filter((answer) => answer.logicalItemId === group.logicalItemId));
      let workspace: CategoryDraft | undefined = session.draft?.logicalItemId === group.logicalItemId ? session.draft.workspace : undefined;
      if (!session.progress[group.logicalItemId]) {
        try {
          const local = sessionStorage.getItem(draftKey(auth.studentId, id, group.logicalItemId));
          if (local) workspace = JSON.parse(local) as CategoryDraft;
        } catch { /* unavailable storage must not block canonical server resume */ }
      }
      return {
        attempt: categorySourceSummary(session, group), initialAnswers: workspace?.answers ?? {}, workspace,
        prepareAnswers: rows.length ? (practice) => buildSubmittedReadingAnswerState(practice, rows) : undefined
      };
    },
    submit: async ({ sessionId: id, group, answers, elapsedSeconds, auth }) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const payload = await categoryFetch<CategorySubmitPayload>(categoryGroupUrl(id, group.logicalItemId), auth, { answers, elapsedSeconds });
      const previous = sessionRef.current;
      const merged = {
        session: payload.session,
        answers: [...(previous?.answers ?? []).filter((answer) => answer.logicalItemId !== group.logicalItemId), ...payload.answers]
      };
      sessionRef.current = merged;
      cacheRef.current.setData(key, merged);
      cacheRef.current.setData(categorySessionCacheKey(id), merged);
      try { sessionStorage.removeItem(draftKey(auth.studentId, id, group.logicalItemId)); } catch { /* optional cache */ }
      cacheRef.current.invalidate(STUDENT_PRACTICE_HISTORY_CACHE_PREFIX);
      if (payload.session.status === "completed") cacheRef.current.invalidate(STUDENT_DASHBOARD_SUMMARY_CACHE_KEY);
      invalidateStudentWrongbook(auth.studentId);
      const rows = categoryAnswerRows(payload.answers);
      return { attempt: categorySourceSummary(payload.session, group), initialAnswers: {},
        prepareAnswers: (practice) => buildSubmittedReadingAnswerState(practice, rows) };
    },
    saveDraft: ({ sessionId: id, group, answers, currentIndex, questionTimes, elapsedSeconds, auth }) => {
      const draft = { answers, currentIndex, questionTimes, elapsedSeconds };
      // Immediate same-browser refresh checkpoint; server autosave follows without
      // blocking typing. Late saves are ignored by the locked RPC after submit.
      try { sessionStorage.setItem(draftKey(auth.studentId, id, group.logicalItemId), JSON.stringify(draft)); } catch { /* optional cache */ }
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void categoryFetch(categoryGroupUrl(id, group.logicalItemId), auth, draft, "PATCH")
          .then(() => setSaveError(""))
          .catch(() => setSaveError("进度暂时仅保存在当前浏览器，正在重试同步。"));
      }, 500);
    }
  }), [key, nonce]);
  if (state.error) return <ReadingSessionMessage title="无法进入练习" description={state.error} onBack={() => router.push(CATEGORY_ROUTE)} />;
  if (!practiceSession) return <ReadingSessionMessage title="正在准备练习" description="正在加载本次练习..." />;
  return <ReadingMultiSourceSessionRunner adapter={adapter} session={practiceSession}
    saveError={saveError}
    title={categorySessionTitle(practiceSession.questionCategory)} onBack={() => router.push(CATEGORY_ROUTE)}
    onCompleted={() => router.replace(categoryResultHref(practiceSession.sessionId))} />;
}
