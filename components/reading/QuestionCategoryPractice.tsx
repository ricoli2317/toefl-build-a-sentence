"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useStudentCachedData, useStudentDataCache, STUDENT_PRACTICE_HISTORY_CACHE_PREFIX, STUDENT_DASHBOARD_SUMMARY_CACHE_KEY, type StudentCacheSession } from "@/components/StudentDataCache";
import { ReadingMultiSourceSessionRunner, ReadingSessionMessage, type ReadingSessionAdapter } from "./ReadingMultiSourceSessionRunner";
import {
  CATEGORY_API, CATEGORY_ROUTE, categoryAnswerRows, categoryResultHref, categorySessionTitle, categoryWorkspace, categorySourceElapsedSeconds,
  type CategorySession, type CategorySessionPayload, type CategorySubmitPayload, type CategoryDraft,
  type ReadingQuestionCategory
} from "@/lib/reading/questionCategory";
import { categoryFetch, categoryGroupUrl, categoryPracticeCacheKey, categorySessionCacheKey, loadCategorySession } from "@/lib/reading/questionCategory.client";
import { buildSubmittedReadingAnswerState } from "@/lib/reading/review";
import { invalidateStudentWrongbook } from "@/lib/studentCacheEvents";
import type { WrongQuestionSessionGroup } from "@/lib/wrongQuestionBank";
import type { ReadingAttemptSummary } from "@/lib/reading/attempts";
import { createCategoryDraftQueue } from "@/lib/reading/categoryDraftQueue";

const creations = new Map<string, Promise<CategorySessionPayload>>();
const draftKey = (studentId: string, id: string, itemId: string) => `tps:category-draft:${studentId}:${id}:${itemId}`;
const positionKey = (studentId: string, id: string) => `tps:category-position:${studentId}:${id}`;

/** Renderer metadata only; NO attempt is inserted or submitted for a category source. */
export function categorySourceSummary(session: CategorySession, group: WrongQuestionSessionGroup): ReadingAttemptSummary {
  const progress = session.progress[group.logicalItemId];
  return {
    attemptId: session.sessionId, logicalItemId: group.logicalItemId, taskType: "rap",
    status: session.status === "completed" ? "submitted" : "draft", startedAt: session.createdAt,
    submittedAt: session.status === "completed" ? session.completedAt : null, elapsedSeconds: progress?.elapsedSeconds ?? 0,
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
  const revision = useRef(0);
  const key = `reading:category-entry:${pinned || "create"}:${nonce}`;
  const state = useStudentCachedData<CategorySessionPayload>(key, async (auth) => {
    if (pinned) {
      const payload = await loadCategorySession(pinned, auth);
      if (payload.session.status === "active") try {
        const raw = sessionStorage.getItem(positionKey(auth.studentId, pinned));
        const position = raw ? JSON.parse(raw) as { itemId: string; revision: number } : null;
        const group = payload.session.groups.find((group) => group.logicalItemId === position?.itemId);
        const local = group && sessionStorage.getItem(draftKey(auth.studentId, pinned, group.logicalItemId));
        const workspace = local ? JSON.parse(local) as CategoryDraft : null;
        if (group && position && workspace && position.revision === workspace.revision
          && position.revision >= (payload.session.draft?.workspace?.revision ?? 0)
          && position.revision > (payload.session.progress[group.logicalItemId]?.revision ?? 0)) {
          payload.session.draft = { ...payload.session.draft, logicalItemId: group.logicalItemId, workspace };
          payload.session.draft.workspaces = { ...payload.session.draft.workspaces, [group.logicalItemId]: workspace };
        }
      } catch { /* server resume works even without browser storage */ }
      return payload;
    }
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
  const sourceElapsedSeconds = useMemo(() => practiceSession ? categorySourceElapsedSeconds(practiceSession) : {}, [practiceSession]);
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

  const draftQueue = useMemo(() => createCategoryDraftQueue<{
    id: string; draft: CategoryDraft; auth: StudentCacheSession;
  }>(async (itemId, input) => {
    await categoryFetch(categoryGroupUrl(input.id, itemId), input.auth, input.draft, "PATCH");
    setSaveError("");
  }), []);
  useEffect(() => () => draftQueue.dispose(), [draftQueue]);
  const adapter = useMemo<ReadingSessionAdapter>(() => ({
    isSourceEditable: (_source, session) => session.status === "active",
    sourceCacheKey: (id, itemId) => `reading:category-source:${id}:${itemId}:${nonce}`,
    practiceCacheKey: categoryPracticeCacheKey,
    loadSource: async (id, group, auth) => {
      const payload = sessionRef.current ?? await loadCategorySession(id, auth);
      const session = payload.session;
      revision.current = Math.max(revision.current, ...Object.values(session.progress).map((progress) => progress.revision ?? 0),
        ...Object.values(session.draft?.workspaces ?? {}).map((workspace) => workspace.revision ?? 0));
      const rows = categoryAnswerRows(payload.answers.filter((answer) => answer.logicalItemId === group.logicalItemId));
      let workspace: CategoryDraft | undefined = categoryWorkspace(session, group.logicalItemId);
      if (session.status === "active") {
        try {
          const local = sessionStorage.getItem(draftKey(auth.studentId, id, group.logicalItemId));
          if (local) {
            const parsed = JSON.parse(local) as CategoryDraft;
            if ((parsed.revision ?? 0) >= (workspace?.revision ?? 0)
              && (parsed.revision ?? 0) > (session.progress[group.logicalItemId]?.revision ?? 0)) workspace = parsed;
          }
        } catch { /* unavailable storage must not block canonical server resume */ }
      }
      revision.current = Math.max(revision.current, workspace?.revision ?? 0);
      return {
        attempt: categorySourceSummary(session, group), initialAnswers: workspace?.answers ?? {},
        workspace: workspace ?? { currentIndex: 0, elapsedSeconds: session.progress[group.logicalItemId]?.elapsedSeconds ?? 0,
          questionTimes: Object.fromEntries(rows.map((row) => [row.question_id, row.question_time_seconds ?? 0])) },
        persistedElapsedSeconds: session.progress[group.logicalItemId]?.elapsedSeconds ?? 0,
        prepareAnswers: workspace ? undefined : rows.length ? (practice) => buildSubmittedReadingAnswerState(practice, rows) : undefined
      };
    },
    flushDraft: (itemId) => draftQueue.flush(itemId),
    submit: async ({ sessionId: id, group, answers, elapsedSeconds, auth, finalize }) => {
      await draftQueue.flush(group.logicalItemId);
      revision.current = Math.max(Date.now(), revision.current + 1);
      const payload = await categoryFetch<CategorySubmitPayload>(categoryGroupUrl(id, group.logicalItemId), auth, {
        answers, elapsedSeconds, finalize, revision: revision.current
      });
      const previous = sessionRef.current;
      const merged = {
        session: payload.session,
        answers: payload.session.status === "completed" ? payload.answers
          : [...(previous?.answers ?? []).filter((answer) => answer.logicalItemId !== group.logicalItemId), ...payload.answers]
      };
      sessionRef.current = merged;
      cacheRef.current.setData(key, merged);
      cacheRef.current.setData(categorySessionCacheKey(id), merged);
      try { sessionStorage.removeItem(draftKey(auth.studentId, id, group.logicalItemId)); } catch { /* optional cache */ }
      if (payload.session.status === "completed") {
        cacheRef.current.invalidate(STUDENT_PRACTICE_HISTORY_CACHE_PREFIX);
        cacheRef.current.invalidate(STUDENT_DASHBOARD_SUMMARY_CACHE_KEY);
        invalidateStudentWrongbook(auth.studentId);
      }
      const rows = categoryAnswerRows(payload.answers.filter((answer) => answer.logicalItemId === group.logicalItemId));
      return { attempt: categorySourceSummary(payload.session, group), initialAnswers: {},
        sessionCompleted: payload.session.status === "completed", persistedElapsedSeconds: payload.group.elapsedSeconds,
        prepareAnswers: (practice) => buildSubmittedReadingAnswerState(practice, rows) };
    },
    saveDraft: ({ sessionId: id, group, answers, currentIndex, questionTimes, elapsedSeconds, auth }) => {
      revision.current = Math.max(Date.now(), revision.current + 1);
      const draft = { answers, currentIndex, questionTimes, elapsedSeconds, revision: revision.current };
      // Immediate same-browser refresh checkpoint; server autosave follows without
      // blocking typing. Revisions stop late saves overwriting a newer snapshot.
      try {
        sessionStorage.setItem(draftKey(auth.studentId, id, group.logicalItemId), JSON.stringify(draft));
        sessionStorage.setItem(positionKey(auth.studentId, id), JSON.stringify({ itemId: group.logicalItemId, revision: draft.revision }));
      } catch { /* optional cache */ }
      draftQueue.schedule(group.logicalItemId, { id, draft, auth }, () => setSaveError("进度暂时仅保存在当前浏览器，正在重试同步。"));
    }
  }), [draftQueue, key, nonce]);
  if (state.error) return <ReadingSessionMessage title="无法进入练习" description={state.error} onBack={() => router.push(CATEGORY_ROUTE)} />;
  if (!practiceSession) return <ReadingSessionMessage title="正在准备练习" description="正在加载本次练习..." />;
  return <ReadingMultiSourceSessionRunner adapter={adapter} session={{ ...practiceSession,
    resumeItemId: practiceSession.draft?.logicalItemId, sourceElapsedSeconds,
    elapsedSeconds: Object.values(sourceElapsedSeconds).reduce((total, seconds) => total + seconds, 0) }}
    saveError={saveError}
    title={categorySessionTitle(practiceSession.questionCategory)} onBack={() => router.push(CATEGORY_ROUTE)}
    onCompleted={() => router.replace(categoryResultHref(practiceSession.sessionId))} />;
}
