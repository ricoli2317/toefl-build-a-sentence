"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useStudentCachedData, useStudentDataCache, type StudentCacheSession
} from "@/components/StudentDataCache";
import { ReadingPracticeShell, ReadingPracticePendingShell } from "./ReadingPractice";
import { buildReadingSubmissionAnswers, type ReadingAttemptSummary } from "@/lib/reading/attempts";
import { selectReadingTargetPractice, selectReadingWrongbookSubmissionAnswers } from "@/lib/reading/wrongbook";
import { setReadingAnswer, type ReadingAnswer, type ReadingAnswerState } from "@/lib/reading/practiceState";
import type { StudentReadingPracticePayload } from "@/lib/reading/studentPractice";
import type { WrongQuestionSessionGroup } from "@/lib/wrongQuestionBank";
import { readingWrongbookSessionGroupStarts, readingWrongbookSessionProgressLabel } from "@/lib/reading/wrongbookSession";

export type ReadingSessionSource = {
  /** A renderer summary, not necessarily a database attempt (category has none). */
  attempt: ReadingAttemptSummary;
  initialAnswers: ReadingAnswerState;
  prepareAnswers?: (practice: StudentReadingPracticePayload) => ReadingAnswerState;
  workspace?: { currentIndex: number; questionTimes: Record<string, number>; elapsedSeconds: number };
  persistedElapsedSeconds?: number;
  sessionCompleted?: boolean;
};
export type ReadingSessionManifest = {
  sessionId: string;
  groups: WrongQuestionSessionGroup[];
  progress: Record<string, unknown>;
  elapsedSeconds?: number | null;
  status: "active" | "completed";
  resumeItemId?: string;
  sourceElapsedSeconds?: Record<string, number>;
};
export type ReadingSessionAdapter = {
  isSourceEditable: (source: ReadingSessionSource, session: ReadingSessionManifest) => boolean;
  sourceCacheKey: (sessionId: string, itemId: string) => string;
  practiceCacheKey: (itemId: string) => string;
  loadSource: (sessionId: string, group: WrongQuestionSessionGroup, auth: StudentCacheSession) => Promise<ReadingSessionSource>;
  submit: (input: {
    sessionId: string; group: WrongQuestionSessionGroup; source: ReadingSessionSource;
    answers: ReturnType<typeof buildReadingSubmissionAnswers>; elapsedSeconds: number; auth: StudentCacheSession; finalize: boolean;
  }) => Promise<ReadingSessionSource>;
  saveDraft?: (input: {
    sessionId: string; group: WrongQuestionSessionGroup; answers: ReadingAnswerState;
    currentIndex: number; questionTimes: Record<string, number>; elapsedSeconds: number; auth: StudentCacheSession;
  }) => void;
  flushDraft?: (itemId: string) => Promise<void>;
};
type GroupReady = ReadingSessionSource & { practice: StudentReadingPracticePayload; item: WrongQuestionSessionGroup };

export async function loadReadingSessionPractice(itemId: string, auth: StudentCacheSession) {
  const response = await fetch(`/api/reading/practice/${encodeURIComponent(itemId)}`, {
    cache: "no-store", headers: { Authorization: `Bearer ${auth.accessToken}` }
  });
  const payload = await response.json();
  if (!response.ok || !payload.practice || payload.practice.item.itemId !== itemId) {
    throw new Error(payload.error ?? "阅读内容加载失败，请稍后重试。");
  }
  return payload as { practice: StudentReadingPracticePayload };
}

/** Shared runner extracted from wrongbook bank practice. The adapter owns ALL
 * business semantics. This layer owns source-first hydration, one-next prefetch,
 * stable shell, cross-source navigation, frozen numbering and cumulative time.
 */
export function ReadingMultiSourceSessionRunner({
  adapter, session: practiceSession, title: sessionTitle, onBack, onCompleted, saveError
}: {
  adapter: ReadingSessionAdapter;
  session: ReadingSessionManifest;
  title: string;
  onBack: () => void;
  onCompleted: () => void;
  saveError?: string;
}) {
  const cache = useStudentDataCache();
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;
  const serverSessionId = practiceSession.sessionId;
  const groups = practiceSession.groups;
  const groupStarts = useMemo(() => readingWrongbookSessionGroupStarts(groups), [groups]);
  const totalPoints = groups.reduce((sum, group) => sum + group.targets.length, 0);
  const [groupIndex, setGroupIndex] = useState(() => {
    const resumed = groups.findIndex((group) => group.logicalItemId === practiceSession.resumeItemId);
    if (resumed !== -1) return resumed;
    const pending = groups.findIndex((group) => !practiceSession.progress[group.logicalItemId]);
    return pending === -1 ? groups.length - 1 : pending;
  });
  const [sourceEntryIndex, setSourceEntryIndex] = useState(0);
  const [sourcePendingText, setSourcePendingText] = useState("正在加载下一篇材料...");
  const group = groups[groupIndex];
  const hasPreviousSource = groupIndex > 0;
  const attemptState = useStudentCachedData<ReadingSessionSource>(
    adapter.sourceCacheKey(serverSessionId, group?.logicalItemId ?? "none"),
    (auth) => adapterRef.current.loadSource(serverSessionId, group, auth),
    { enabled: Boolean(group) }
  );
  const practiceState = useStudentCachedData<{ practice: StudentReadingPracticePayload }>(
    adapter.practiceCacheKey(group?.logicalItemId ?? "none"),
    (auth) => loadReadingSessionPractice(group.logicalItemId, auth),
    { enabled: Boolean(group) }
  );
  const groupReady = useMemo<GroupReady | null>(() => {
    if (!group || !attemptState.data || !practiceState.data?.practice) return null;
    const practice = selectReadingTargetPractice(practiceState.data.practice, group.targets);
    return {
      ...attemptState.data, item: group,
      practice,
      initialAnswers: attemptState.data.prepareAnswers?.(practice) ?? attemptState.data.initialAnswers
    };
  }, [attemptState.data, group, practiceState.data]);
  const [rendered, setRendered] = useState<{ logicalItemId: string; ready: GroupReady } | null>(null);
  const [answersByGroup, setAnswersByGroup] = useState<Record<string, ReadingAnswerState>>({});
  const sourceTimes = useRef<Record<string, number>>({ ...practiceSession.sourceElapsedSeconds });
  const workspaces = useRef<Record<string, { currentIndex: number; questionTimes: Record<string, number> }>>({});
  const clock = useRef({ total: practiceSession.elapsedSeconds ?? 0, startedAt: null as number | null, itemId: "" });
  const [sessionElapsed, setSessionElapsed] = useState(practiceSession.elapsedSeconds ?? 0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const finished = useRef(false);
  const sourceReadOnly = rendered ? !adapter.isSourceEditable(rendered.ready, practiceSession) : false;

  const currentElapsed = useCallback(() => clock.current.total + (clock.current.startedAt === null ? 0
    : Math.max(0, Math.round((Date.now() - clock.current.startedAt) / 1000))), []);
  const flushElapsed = useCallback(() => {
    if (clock.current.startedAt === null) return;
    const delta = currentElapsed() - clock.current.total;
    sourceTimes.current[clock.current.itemId] = (sourceTimes.current[clock.current.itemId] ?? 0) + delta;
    clock.current.total += delta;
    clock.current.startedAt = null;
    setSessionElapsed(clock.current.total);
  }, [currentElapsed]);

  useEffect(() => {
    if (!groupReady || !group) return;
    setRendered((current) => current?.logicalItemId === group.logicalItemId
      && current.ready.attempt.status === groupReady.attempt.status ? current
      : { logicalItemId: group.logicalItemId, ready: groupReady });
    setAnswersByGroup((map) => map[group.logicalItemId]
      ? map
      : { ...map, [group.logicalItemId]: groupReady.initialAnswers });
    if (sourceTimes.current[group.logicalItemId] === undefined) {
      const restored = adapterRef.current.isSourceEditable(groupReady, practiceSession)
        ? groupReady.workspace?.elapsedSeconds ?? groupReady.attempt.elapsedSeconds : 0;
      sourceTimes.current[group.logicalItemId] = restored;
      clock.current.total += Math.max(0, restored - (groupReady.persistedElapsedSeconds ?? 0));
    }
  }, [group, groupReady, practiceSession]);

  const pending = !rendered || rendered.logicalItemId !== group?.logicalItemId;
  const renderedItemId = rendered?.logicalItemId ?? "";
  useEffect(() => {
    flushElapsed();
    clock.current.itemId = renderedItemId;
  }, [flushElapsed, renderedItemId]);

  useEffect(() => {
    if (pending || submitting || !rendered || sourceReadOnly) {
      flushElapsed(); return;
    }
    if (clock.current.startedAt === null) clock.current.startedAt = Date.now();
    setSessionElapsed(currentElapsed());
    const timer = window.setInterval(() => setSessionElapsed(currentElapsed()), 250);
    return () => { window.clearInterval(timer); flushElapsed(); };
  }, [currentElapsed, flushElapsed, pending, rendered, sourceReadOnly, submitting]);

  const saveCheckpoint = useCallback((currentIndex: number, questionTimes: Record<string, number>) => {
    if (rendered && !pending) workspaces.current[rendered.logicalItemId] = { currentIndex, questionTimes };
    const auth = cacheRef.current.getSession();
    if (!auth || !rendered || pending || submitting || sourceReadOnly) return;
    const delta = currentElapsed() - clock.current.total;
    adapterRef.current.saveDraft?.({
      sessionId: serverSessionId, group: rendered.ready.item,
      answers: answersByGroup[rendered.logicalItemId] ?? rendered.ready.initialAnswers,
      currentIndex, questionTimes, elapsedSeconds: (sourceTimes.current[rendered.logicalItemId] ?? 0) + delta, auth
    });
  }, [answersByGroup, currentElapsed, pending, rendered, serverSessionId, sourceReadOnly, submitting]);

  const handlePreviousSource = useCallback(async () => {
    if (groupIndex <= 0 || pending || submitting) return;
    flushElapsed();
    if (adapterRef.current.flushDraft && group) {
      setSubmitting(true);
      try { await adapterRef.current.flushDraft(group.logicalItemId); }
      catch (error) { setSubmitError(error instanceof Error ? error.message : "进度保存失败，请重试。"); setSubmitting(false); return; }
      setSubmitting(false);
    }
    const target = groups[groupIndex - 1];
    setSourcePendingText("正在加载上一篇材料...");
    setSourceEntryIndex(Math.max(0, target.targets.length - 1));
    setGroupIndex(groupIndex - 1);
  }, [flushElapsed, group, groupIndex, groups, pending, submitting]);

  // Content AND source state of ONE next group only. Never wait for all sources.
  const preloadedRef = useRef(new Set<string>());
  useEffect(() => {
    const next = groups[groupIndex + 1];
    if (!next) return;
    const practiceKey = adapterRef.current.practiceCacheKey(next.logicalItemId);
    if (!preloadedRef.current.has(practiceKey)) {
      preloadedRef.current.add(practiceKey);
      void cacheRef.current.load(practiceKey, (auth) => loadReadingSessionPractice(next.logicalItemId, auth))
        .then((payload) => {
          const imageUrl = payload?.practice?.material?.imageUrl;
          if (!imageUrl) return;
          const image = new window.Image(); image.decoding = "async"; image.src = imageUrl;
        });
    }
    const attemptKey = adapterRef.current.sourceCacheKey(serverSessionId, next.logicalItemId);
    if (!preloadedRef.current.has(attemptKey)) {
      preloadedRef.current.add(attemptKey);
      void cacheRef.current.load(attemptKey, (auth) => adapterRef.current.loadSource(serverSessionId, next, auth));
    }
  }, [groupIndex, groups, serverSessionId]);

  const handleAnswerChange = useCallback((questionId: string, answer: ReadingAnswer) => {
    if (!rendered) return;
    setAnswersByGroup((map) => ({ ...map,
      [rendered.logicalItemId]: setReadingAnswer(map[rendered.logicalItemId] ?? rendered.ready.initialAnswers, questionId, answer)
    }));
  }, [rendered]);
  const advance = useCallback(() => {
    setSourceEntryIndex(0);
    setSourcePendingText("正在加载下一篇材料...");
    if (groupIndex + 1 < groups.length) setGroupIndex(groupIndex + 1);
    else onCompleted();
  }, [groupIndex, groups.length, onCompleted]);
  const completeWorkspace = useCallback(async (questionTimes: Record<string, number>) => {
    if (finished.current || submitting || !group || !rendered || pending) return;
    // Wrongbook adapter keeps submitted sources read-only. Category saves remain
    // editable until the WHOLE session completes.
    if (!adapterRef.current.isSourceEditable(rendered.ready, practiceSession)) { advance(); return; }
    flushElapsed();
    setSubmitting(true); setSubmitError("");
    try {
      const auth = cacheRef.current.getSession();
      if (!auth) throw new Error("请先登录后再提交阅读练习。");
      const answers = selectReadingWrongbookSubmissionAnswers(buildReadingSubmissionAnswers(
        rendered.ready.practice, answersByGroup[rendered.logicalItemId] ?? rendered.ready.initialAnswers, questionTimes
      ), group.targets);
      const source = await adapterRef.current.submit({
        sessionId: serverSessionId, group, source: rendered.ready, answers,
        elapsedSeconds: sourceTimes.current[group.logicalItemId] ?? 0, auth, finalize: groupIndex + 1 === groups.length
      });
      if (source.sessionCompleted || groupIndex + 1 === groups.length) {
        // Keep the active workspace in finishing state until navigation unmounts
        // it. Do NOT publish a submitted source into the shell for one frame.
        finished.current = true;
        onCompleted();
        return;
      }
      const initialAnswers = source.prepareAnswers?.(rendered.ready.practice)
        ?? answersByGroup[group.logicalItemId] ?? source.initialAnswers;
      cacheRef.current.setData(adapterRef.current.sourceCacheKey(serverSessionId, group.logicalItemId), { ...source, initialAnswers });
      setAnswersByGroup((map) => ({ ...map, [group.logicalItemId]: initialAnswers }));
      setRendered({ logicalItemId: group.logicalItemId, ready: { ...rendered.ready, ...source, initialAnswers } });
      setSubmitting(false); advance();
    } catch (failure) {
      setSubmitError(failure instanceof Error ? failure.message : "阅读答案提交失败，请稍后重试。");
      setSubmitting(false);
    }
  }, [advance, answersByGroup, flushElapsed, group, groupIndex, groups.length, onCompleted, pending, practiceSession, rendered, serverSessionId, submitting]);

  const progressLabelResolver = useMemo(() => (currentIndex: number) => readingWrongbookSessionProgressLabel({
    currentIndex, groupStart: groupStarts[groupIndex] ?? 0, module: rendered?.ready.practice.item.module ?? "rap",
    targetCount: group?.targets.length ?? 0, totalPoints
  }), [group, groupIndex, groupStarts, rendered, totalPoints]);
  const loadError = attemptState.error || practiceState.error;
  if (!rendered) {
    if (loadError) return <ReadingSessionMessage title="无法进入练习" description={loadError} onBack={onBack} />;
    if (practiceState.data?.practice) return <ReadingPracticePendingShell practice={practiceState.data.practice} onBack={onBack} reviewTitle={sessionTitle} />;
    return <ReadingSessionMessage title="正在准备练习" description="正在加载阅读材料..." />;
  }
  const workspace = groupReady && adapter.isSourceEditable(groupReady, practiceSession)
    ? workspaces.current[group?.logicalItemId] ?? groupReady?.workspace : undefined;
  return <ReadingPracticeShell
    attempt={rendered.ready.attempt} practice={rendered.ready.practice} reviewTitle={sessionTitle}
    onBack={onBack} progressLabelResolver={progressLabelResolver}
    initialQuestionIndex={rendered.ready.workspace?.currentIndex ?? sourceEntryIndex}
    initialQuestionTimes={rendered.ready.workspace?.questionTimes}
    session={{
      answers: answersByGroup[rendered.logicalItemId] ?? rendered.ready.initialAnswers,
      completionLabel: groupIndex + 1 < groups.length ? "Next" : "Submit",
      elapsedSeconds: sessionElapsed, hasPreviousSource, navigationDisabled: pending,
      sourceReadOnly,
      onAnswerChange: handleAnswerChange, onCompleteWorkspace: (times) => { void completeWorkspace(times); },
      onPreviousSource: handlePreviousSource, onCheckpoint: saveCheckpoint,
      pending: pending || submitting, pendingText: submitting ? "正在保存练习..." : loadError || sourcePendingText,
      sourceEntryIndex: workspace?.currentIndex ?? sourceEntryIndex,
      sourceQuestionTimes: workspace?.questionTimes,
      submitError: submitError || saveError || "", submitting, targets: group?.targets ?? []
    }}
  />;
}

export function ReadingSessionMessage({ title, description, onBack }: { title: string; description: string; onBack?: () => void }) {
  return <main className="reading-theme flex min-h-screen items-center justify-center bg-[#fbfbfe] px-5">
    <section className="student-card w-full max-w-lg p-8 text-center">
      <h1 className="text-2xl font-bold text-student-text">{title}</h1>
      <p className="mt-3 text-sm leading-6 text-student-muted">{description}</p>
      {onBack ? <button className="student-button-primary mt-6" onClick={onBack} type="button">返回</button> : null}
    </section>
  </main>;
}
