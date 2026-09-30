"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  studentWrongQuestionsCacheKey,
  useStudentCachedData,
  useStudentDataCache,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  ReadingPracticePendingShell,
  ReadingPracticeShell
} from "@/components/reading/ReadingPractice";
import { STUDENT_ROUTES, withStudentReturnTo } from "@/lib/studentNavigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { buildReadingSubmissionAnswers } from "@/lib/reading/attempts";
import type { ReadingAttemptSummary } from "@/lib/reading/attempts";
import {
  setReadingAnswer,
  type ReadingAnswer,
  type ReadingAnswerState
} from "@/lib/reading/practiceState";
import type { StudentReadingPracticePayload } from "@/lib/reading/studentPractice";
import type { ReadingModule } from "@/lib/reading/types";
import {
  readingWrongbookSessionGroupStarts,
  readingWrongbookSessionProgressLabel
} from "@/lib/reading/wrongbookSession";
import type { WrongQuestionPracticeSession } from "@/lib/wrongQuestionBank";
import {
  buildReadingWrongbookInitialAnswers,
  isReadingWrongbookAttemptSummary,
  selectReadingWrongbookPractice,
  selectReadingWrongbookSubmissionAnswers,
  type ReadingWrongbookAttemptSummary,
  type ReadingWrongbookContextAnswer,
  type ReadingWrongbookPracticeItem,
  type ReadingWrongbookPreservedAnswer
} from "@/lib/reading/wrongbook";
import { invalidateStudentWrongbook } from "@/lib/studentCacheEvents";

type SessionPayload = { error?: string; session?: WrongQuestionPracticeSession };
type AttemptPayload = {
  attempt?: unknown;
  contextAnswers?: ReadingWrongbookContextAnswer[];
  error?: string;
  item?: ReadingWrongbookPracticeItem;
  preservedAnswers?: ReadingWrongbookPreservedAnswer[];
};
type PracticePayload = { error?: string; practice?: StudentReadingPracticePayload };
type EntryUnit = {
  attempt: ReadingWrongbookAttemptSummary;
  contextAnswers: ReadingWrongbookContextAnswer[];
  item: ReadingWrongbookPracticeItem;
  preservedAnswers: ReadingWrongbookPreservedAnswer[];
};
type GroupReady = {
  attempt: ReadingWrongbookAttemptSummary;
  initialAnswers: ReadingAnswerState;
  item: ReadingWrongbookPracticeItem;
  practice: StudentReadingPracticePayload;
};

/**
 * In-flight session creations keyed by the creation query. A cache
 * invalidation (submit / rerender) must never fire a second POST: the frozen
 * draw is pinned into React state + URL and every later read resumes it.
 */
const readingSessionCreations = new Map<string, Promise<SessionPayload>>();

/**
 * Bank-driven Reading wrong-question practice:
 *   * today   - all currently pending questions of one task type
 *   * history - a frozen random session from the history bank
 *   * entry   - the wrong targets of one source attempt
 *
 * History / today sessions are one continuous practice: the session shell
 * (header, title, timer, global numbering) stays mounted while only the
 * current source workspace is swapped. The current source is prefetched; a
 * source that is still loading shows a local pending state instead of tearing
 * the shell down.
 */
export function ReadingWrongbookBankPractice({
  amount,
  entryAttemptId,
  mode,
  returnTo,
  sessionId,
  taskType
}: {
  amount?: number;
  entryAttemptId?: string;
  mode: "entry" | "history" | "today";
  returnTo?: string | null;
  sessionId?: string;
  taskType: ReadingModule;
}) {
  const router = useRouter();
  const cache = useStudentDataCache();
  const isEntry = mode === "entry";
  const backHref = returnTo?.trim() || STUDENT_ROUTES.wrongQuestions;
  const [pinnedSessionId, setPinnedSessionId] = useState("");
  const activeSessionId = isEntry ? "" : sessionId ?? pinnedSessionId;
  /**
   * A chooser entry (no frozen session id in the URL) must always create a
   * brand-new session. The cache keeps the manifest of the previous session
   * under the chooser key and only marks it stale after submits, so reusing
   * that key would render the old session first and then replace it with the
   * fresh one — wrong-group flashes, stray auto-advances and old result pages.
   * A per-mount nonce makes each entry its own key; resume still happens
   * through the pinned `sessionId` key (refresh / back).
   */
  const [entryNonce] = useState(() =>
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  const manifestQuery = useMemo(() => {
    if (isEntry) return `entry:${taskType}:${entryAttemptId ?? ""}`;
    const params = new URLSearchParams({ mode, taskType });
    if (mode === "history" && amount) params.set("amount", String(amount));
    if (activeSessionId) params.set("sessionId", activeSessionId);
    else params.set("entry", entryNonce);
    return params.toString();
  }, [activeSessionId, amount, entryAttemptId, entryNonce, isEntry, mode, taskType]);

  const manifestState = useStudentCachedData<EntryUnit | SessionPayload>(
    studentWrongQuestionsCacheKey(`reading-bank:${mode}:${manifestQuery}`),
    (session) => isEntry
      ? loadEntryUnit(entryAttemptId ?? "", taskType, session)
      : loadBankSession(mode, taskType, manifestQuery, session),
    { enabled: isEntry ? Boolean(entryAttemptId) : true }
  );

  const entryUnit = isEntry ? manifestState.data as EntryUnit | null : null;
  const practiceSession = !isEntry ? (manifestState.data as SessionPayload | null)?.session ?? null : null;
  const serverSessionId = isEntry ? "" : practiceSession?.sessionId ?? "";
  const groups = useMemo(() => practiceSession?.groups ?? [], [practiceSession]);
  const totalPoints = useMemo(
    () => groups.reduce((sum, group) => sum + group.targets.length, 0),
    [groups]
  );
  const groupStarts = useMemo(() => readingWrongbookSessionGroupStarts(groups), [groups]);
  const sessionTitle = mode === "today" ? "今日错题订正" : "历史错题练习";

  // The created session is pinned into React state (cache key + loader) and the
  // URL at the same time, so refresh / back / an invalidation can only resume
  // the exact same frozen draw.
  useEffect(() => {
    if (isEntry || sessionId || !serverSessionId || pinnedSessionId === serverSessionId) return;
    if (typeof window === "undefined") return;
    const pinnedQuery = new URLSearchParams({ mode, taskType });
    if (mode === "history" && amount) pinnedQuery.set("amount", String(amount));
    pinnedQuery.set("sessionId", serverSessionId);
    cache.setData(
      studentWrongQuestionsCacheKey(`reading-bank:${mode}:${pinnedQuery.toString()}`),
      manifestState.data
    );
    setPinnedSessionId(serverSessionId);
    const url = new URL(window.location.href);
    if (url.searchParams.get("session") === serverSessionId) return;
    url.searchParams.set("session", serverSessionId);
    window.history.replaceState(null, "", url.toString());
  }, [
    amount,
    cache,
    isEntry,
    manifestState.data,
    mode,
    pinnedSessionId,
    serverSessionId,
    sessionId,
    taskType
  ]);

  const [groupIndex, setGroupIndex] = useState<number | null>(null);
  useEffect(() => {
    if (isEntry || groupIndex !== null || !practiceSession || groups.length === 0) return;
    const pendingIndex = groups.findIndex(
      (group) => !practiceSession.progress?.[group.logicalItemId]
    );
    setGroupIndex(pendingIndex === -1 ? groups.length - 1 : pendingIndex);
  }, [groupIndex, groups, isEntry, practiceSession]);

  /**
   * Workspace index the shell opens a freshly switched source at. Forward
   * progress enters at the first workspace; a backwards Previous enters the
   * previous source at its last workspace (the point the student left it).
   */
  const [sourceEntryIndex, setSourceEntryIndex] = useState(0);
  const [sourcePendingText, setSourcePendingText] = useState("正在加载下一篇材料...");
  const hasPreviousSource = !isEntry && groupIndex !== null && groupIndex > 0;
  const handlePreviousSource = useCallback(() => {
    if (isEntry || groupIndex === null || groupIndex <= 0) return;
    const target = groups[groupIndex - 1];
    if (!target) return;
    // CTW renders one workspace per material; RDL / RAP re-open at the last
    // question of the completed source (the only place the forward action
    // exists). No attempt is created or resubmitted.
    setSourcePendingText("正在加载上一篇材料...");
    setSourceEntryIndex(Math.max(0, target.targets.length - 1));
    setGroupIndex(groupIndex - 1);
  }, [groupIndex, groups, isEntry]);

  // A finished session jumps straight back to its result page.
  useEffect(() => {
    if (isEntry || !serverSessionId || !practiceSession || practiceSession.status !== "completed") {
      return;
    }
    router.replace(withStudentReturnTo(
      `/student/wrong-questions/sessions/${encodeURIComponent(serverSessionId)}`,
      returnTo
    ));
  }, [isEntry, practiceSession, returnTo, router, serverSessionId]);

  const group = !isEntry && groupIndex !== null ? groups[groupIndex] ?? null : null;

  const attemptState = useStudentCachedData<AttemptPayload>(
    studentWrongQuestionsCacheKey(`reading-bank-attempt:${serverSessionId}:${group?.logicalItemId ?? "none"}`),
    (session) => loadGroupAttempt(serverSessionId, group?.logicalItemId ?? "", session),
    { enabled: Boolean(group && serverSessionId) }
  );
  const practiceItemId = isEntry
    ? entryUnit?.item?.logicalItemId ?? ""
    : group?.logicalItemId ?? "";
  const practiceState = useStudentCachedData<PracticePayload>(
    studentWrongQuestionsCacheKey(`reading-correction-practice:${practiceItemId}`),
    (session) => loadPractice(practiceItemId, session),
    { enabled: Boolean(practiceItemId) }
  );

  const entryReady = useMemo(() => {
    if (!isEntry) return null;
    const rawPractice = practiceState.data?.practice;
    if (!rawPractice || !entryUnit?.item || !entryUnit.attempt || !isReadingWrongbookAttemptSummary(entryUnit.attempt)) {
      return null;
    }
    const practice = selectReadingWrongbookPractice(rawPractice, entryUnit.item.targets);
    return {
      attempt: entryUnit.attempt,
      initialAnswers: buildReadingWrongbookInitialAnswers(
        practice,
        entryUnit.preservedAnswers,
        entryUnit.contextAnswers
      ),
      item: entryUnit.item,
      practice
    };
  }, [entryUnit, isEntry, practiceState.data?.practice]);

  const groupReady = useMemo<GroupReady | null>(() => {
    if (isEntry || !group) return null;
    const rawPractice = practiceState.data?.practice;
    const attempt = attemptState.data?.attempt ?? null;
    const item = attemptState.data?.item ?? null;
    if (!rawPractice || !item || !attempt || !isReadingWrongbookAttemptSummary(attempt)) return null;
    const practice = selectReadingWrongbookPractice(rawPractice, item.targets);
    return {
      attempt,
      initialAnswers: buildReadingWrongbookInitialAnswers(
        practice,
        attemptState.data?.preservedAnswers ?? [],
        attemptState.data?.contextAnswers ?? []
      ),
      item,
      practice
    };
  }, [attemptState.data, group, isEntry, practiceState.data?.practice]);

  // The rendered occurrence survives a source switch: while the next source is
  // loading the previous workspace data is kept but hidden behind the local
  // pending state, so the shell never unmounts.
  const [rendered, setRendered] = useState<{ logicalItemId: string; ready: GroupReady } | null>(null);
  const [answersByGroup, setAnswersByGroup] = useState<Record<string, ReadingAnswerState>>({});
  useEffect(() => {
    if (!groupReady || !group) return;
    setRendered((current) => {
      if (
        current?.logicalItemId === group.logicalItemId
        && current.ready.practice.item.itemId === groupReady.practice.item.itemId
      ) {
        return current;
      }
      return { logicalItemId: group.logicalItemId, ready: groupReady };
    });
    setAnswersByGroup((map) => map[group.logicalItemId]
      ? map
      : { ...map, [group.logicalItemId]: groupReady.initialAnswers });
  }, [group, groupReady]);

  const pending = !isEntry
    && groupIndex !== null
    && (!rendered || rendered.logicalItemId !== group?.logicalItemId);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // Session-cumulative elapsed time: counts while a source workspace is
  // answerable, pauses during source loading / submits, and never resets on a
  // source switch.
  const [sessionElapsed, setSessionElapsed] = useState(0);
  const elapsedRef = useRef<{ completed: number; startedAt: number | null }>({
    completed: 0,
    startedAt: null
  });
  const groupBaseElapsedRef = useRef(0);
  const currentElapsed = useCallback(
    () => elapsedRef.current.completed + (elapsedRef.current.startedAt === null
      ? 0
      : Math.max(0, Math.round((Date.now() - elapsedRef.current.startedAt) / 1000))),
    []
  );
  const flushElapsed = useCallback(() => {
    if (elapsedRef.current.startedAt === null) return;
    elapsedRef.current.completed = currentElapsed();
    elapsedRef.current.startedAt = null;
    setSessionElapsed(elapsedRef.current.completed);
  }, [currentElapsed]);

  useEffect(() => {
    if (isEntry) return;
    if (pending || submitting || !rendered) {
      flushElapsed();
      return;
    }
    if (elapsedRef.current.startedAt === null) {
      elapsedRef.current.startedAt = Date.now();
    }
    setSessionElapsed(currentElapsed());
    const timer = window.setInterval(() => setSessionElapsed(currentElapsed()), 250);
    return () => window.clearInterval(timer);
  }, [currentElapsed, flushElapsed, isEntry, pending, rendered, submitting]);

  const renderedItemId = rendered?.logicalItemId ?? "";
  useEffect(() => {
    if (!renderedItemId) return;
    groupBaseElapsedRef.current = currentElapsed();
  }, [currentElapsed, renderedItemId]);

  // Prefetch the next source's content (and its correction record) so the
  // switch is instant whenever possible; only one source is ever mounted.
  const preloadedRef = useRef(new Set<string>());
  useEffect(() => {
    if (isEntry || !group || groupIndex === null) return;
    const next = groups[groupIndex + 1];
    if (!next) return;
    const practiceKey = studentWrongQuestionsCacheKey(`reading-correction-practice:${next.logicalItemId}`);
    if (!preloadedRef.current.has(practiceKey)) {
      preloadedRef.current.add(practiceKey);
      void cache.load(practiceKey, (session) => loadPractice(next.logicalItemId, session))
        .then((payload) => {
          // RDL: one next-material image at most, decoded by the browser cache.
          const imageUrl = payload?.practice?.material?.imageUrl;
          if (!imageUrl || typeof window === "undefined") return;
          const image = new window.Image();
          image.decoding = "async";
          image.src = imageUrl;
        });
    }
    const attemptKey = studentWrongQuestionsCacheKey(
      `reading-bank-attempt:${serverSessionId}:${next.logicalItemId}`
    );
    if (!preloadedRef.current.has(attemptKey) && serverSessionId) {
      preloadedRef.current.add(attemptKey);
      void cache.load(attemptKey, (session) => loadGroupAttempt(
        serverSessionId,
        next.logicalItemId,
        session
      ));
    }
  }, [cache, group, groupIndex, groups, isEntry, serverSessionId]);

  const handleEntrySubmitted = useCallback((submittedAttempt: ReadingAttemptSummary) => {
    router.replace(withStudentReturnTo(
      `/student/reading/wrongbook-results/${encodeURIComponent(submittedAttempt.attemptId)}`,
      returnTo
    ));
  }, [returnTo, router]);

  const handleAnswerChange = useCallback((questionId: string, answer: ReadingAnswer) => {
    if (!rendered) return;
    setAnswersByGroup((map) => ({
      ...map,
      [rendered.logicalItemId]: setReadingAnswer(
        map[rendered.logicalItemId] ?? rendered.ready.initialAnswers,
        questionId,
        answer
      )
    }));
  }, [rendered]);

  const completeWorkspace = useCallback(async (questionTimes: Record<string, number>) => {
    if (isEntry || submitting || !group || !rendered || rendered.logicalItemId !== group.logicalItemId) {
      return;
    }
    // A source re-entered through Previous is already submitted: continue the
    // session without re-submitting or touching the frozen attempt record.
    if (rendered.ready.attempt.status === "submitted") {
      setSourceEntryIndex(0);
      setSourcePendingText("正在加载下一篇材料...");
      if (groupIndex !== null && groupIndex + 1 < groups.length) {
        setGroupIndex(groupIndex + 1);
        return;
      }
      router.replace(withStudentReturnTo(
        `/student/wrong-questions/sessions/${encodeURIComponent(serverSessionId)}`,
        returnTo
      ));
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    const elapsedSeconds = Math.max(0, currentElapsed() - groupBaseElapsedRef.current);
    try {
      const supabase = createBrowserSupabase();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("请先登录后再提交阅读练习。");
      const answers = selectReadingWrongbookSubmissionAnswers(
        buildReadingSubmissionAnswers(
          rendered.ready.practice,
          answersByGroup[rendered.logicalItemId] ?? rendered.ready.initialAnswers,
          questionTimes
        ),
        group.targets
      );
      const response = await fetch(
        `/api/reading/wrongbook-attempts/${encodeURIComponent(rendered.ready.attempt.attemptId)}/submit`,
        {
          method: "POST",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            answers,
            elapsedSeconds,
            logicalItemId: rendered.ready.practice.item.itemId,
            sessionId: serverSessionId
          })
        }
      );
      const payload = await response.json().catch(() => ({})) as AttemptPayload;
      if (!response.ok || !isReadingWrongbookAttemptSummary(payload.attempt)) {
        throw new Error(payload.error ?? "阅读答案提交失败，请稍后重试。");
      }
      invalidateStudentWrongbook(session.user.id);
      setSubmitting(false);
      if (groupIndex !== null && groupIndex + 1 < groups.length) {
        setSourceEntryIndex(0);
        setSourcePendingText("正在加载下一篇材料...");
        setGroupIndex(groupIndex + 1);
        return;
      }
      router.replace(withStudentReturnTo(
        `/student/wrong-questions/sessions/${encodeURIComponent(serverSessionId)}`,
        returnTo
      ));
    } catch (failure) {
      setSubmitError(failure instanceof Error ? failure.message : "阅读答案提交失败，请稍后重试。");
      setSubmitting(false);
    }
  }, [
    answersByGroup,
    currentElapsed,
    group,
    groupIndex,
    groups.length,
    isEntry,
    rendered,
    returnTo,
    router,
    serverSessionId,
    submitting
  ]);

  const progressLabelResolver = useMemo(() => {
    if (isEntry || !rendered || groupIndex === null) return undefined;
    const start = groupStarts[groupIndex] ?? 0;
    return (currentIndex: number) => readingWrongbookSessionProgressLabel({
      currentIndex,
      groupStart: start,
      module: rendered.ready.practice.item.module,
      targetCount: rendered.ready.item.targets.length,
      totalPoints
    });
  }, [groupIndex, groupStarts, isEntry, rendered, totalPoints]);

  const loadError = manifestState.error || attemptState.error || practiceState.error;
  const pendingPreview = practiceState.data?.practice;

  if (isEntry) {
    if (loadError) {
      return (
        <BankMessage
          actionLabel="返回"
          description={loadError}
          onAction={() => router.push(backHref)}
          title="无法进入错题订正"
        />
      );
    }
    if (!entryReady && pendingPreview && (attemptState.loading || manifestState.loading)) {
      return (
        <ReadingPracticePendingShell
          onBack={() => router.push(backHref)}
          practice={pendingPreview}
          reviewTitle="错题订正"
        />
      );
    }
    if (!entryReady) {
      return <BankMessage description="正在加载错题和原题练习界面..." title="正在准备错题订正" />;
    }
    return (
      <ReadingPracticeShell
        attempt={entryReady.attempt}
        initialAnswers={entryReady.initialAnswers}
        key={entryReady.item.logicalItemId}
        onBack={() => router.push(backHref)}
        practice={entryReady.practice}
        resultReturnTo={returnTo}
        reviewTitle="错题订正"
        wrongbook={{
          onSubmitted: handleEntrySubmitted,
          targets: entryReady.item.targets
        }}
      />
    );
  }

  if (loadError && !rendered) {
    return (
      <BankMessage
        actionLabel="返回"
        description={loadError}
        onAction={() => router.push(backHref)}
        title="无法进入错题练习"
      />
    );
  }
  if (!rendered) {
    if (pendingPreview && (attemptState.loading || manifestState.loading)) {
      return (
        <ReadingPracticePendingShell
          onBack={() => router.push(backHref)}
          practice={pendingPreview}
          reviewTitle={sessionTitle}
        />
      );
    }
    return <BankMessage description="正在加载错题和原题练习界面..." title="正在准备错题练习" />;
  }

  const renderedReady = rendered.ready;
  const answers = answersByGroup[rendered.logicalItemId] ?? renderedReady.initialAnswers;
  const completionLabel = groupIndex !== null && groupIndex + 1 < groups.length ? "Next" : "Submit";

  return (
    <ReadingPracticeShell
      attempt={renderedReady.attempt}
      onBack={() => router.push(backHref)}
      practice={renderedReady.practice}
      progressLabelResolver={progressLabelResolver}
      resultReturnTo={returnTo}
      reviewTitle={sessionTitle}
      session={{
        answers,
        completionLabel,
        elapsedSeconds: sessionElapsed,
        hasPreviousSource,
        navigationDisabled: pending,
        onAnswerChange: handleAnswerChange,
        onCompleteWorkspace: (questionTimes) => {
          void completeWorkspace(questionTimes);
        },
        onPreviousSource: handlePreviousSource,
        pending,
        pendingText: sourcePendingText,
        sourceEntryIndex,
        submitError,
        submitting,
        targets: group?.targets ?? []
      }}
    />
  );
}

function BankMessage({
  actionLabel,
  description,
  onAction,
  title
}: {
  actionLabel?: string;
  description: string;
  onAction?: () => void;
  title: string;
}) {
  return (
    <main className="reading-theme flex min-h-screen items-center justify-center bg-[#fbfbfe] px-5">
      <section className="student-card w-full max-w-lg p-8 text-center">
        <h1 className="text-2xl font-bold text-student-text">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-student-muted">{description}</p>
        {actionLabel && onAction ? (
          <button className="student-button-primary mt-6" onClick={onAction} type="button">
            {actionLabel}
          </button>
        ) : null}
      </section>
    </main>
  );
}

async function loadBankSession(
  mode: "entry" | "history" | "today",
  taskType: ReadingModule,
  query: string,
  session: StudentCacheSession
) {
  const params = new URLSearchParams(query);
  const existingSessionId = params.get("sessionId")?.trim() ?? "";
  if (existingSessionId) {
    const response = await fetch(
      `/api/wrong-questions/sessions/${encodeURIComponent(existingSessionId)}`,
      { cache: "no-store", headers: { Authorization: `Bearer ${session.accessToken}` } }
    );
    const payload = await response.json().catch(() => ({})) as SessionPayload;
    if (!response.ok || payload.error) {
      throw new Error(payload.error ?? "错题练习加载失败，请稍后重试。");
    }
    if (
      !payload.session
      || payload.session.taskType !== taskType
      || !payload.session.groups
      || payload.session.groups.length === 0
    ) {
      throw new Error("错题练习数据无效。");
    }
    return payload;
  }
  const inFlight = readingSessionCreations.get(query);
  if (inFlight) return inFlight;
  const creation = createBankSession(mode, taskType, params, session).finally(() => {
    readingSessionCreations.delete(query);
  });
  readingSessionCreations.set(query, creation);
  return creation;
}

async function createBankSession(
  mode: "entry" | "history" | "today",
  taskType: ReadingModule,
  params: URLSearchParams,
  session: StudentCacheSession
) {
  const response = await fetch("/api/wrong-questions/sessions", {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      amount: params.get("amount") ? Number(params.get("amount")) : null,
      mode,
      taskType
    })
  });
  const payload = await response.json().catch(() => ({})) as SessionPayload;
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? "错题练习加载失败，请稍后重试。");
  }
  if (
    !payload.session
    || payload.session.taskType !== taskType
    || !payload.session.groups
    || payload.session.groups.length === 0
  ) {
    throw new Error("错题练习数据无效。");
  }
  return payload;
}

async function loadEntryUnit(
  sourceAttemptId: string,
  taskType: ReadingModule,
  session: StudentCacheSession
): Promise<EntryUnit> {
  const response = await fetch("/api/reading/wrongbook-attempts", {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ mode: "entry", sourceAttemptId, taskType })
  });
  const payload = await response.json().catch(() => ({})) as AttemptPayload;
  if (!response.ok || payload.error || !payload.item || !isReadingWrongbookAttemptSummary(payload.attempt)) {
    throw new Error(payload.error ?? "错题订正加载失败，请稍后重试。");
  }
  return {
    attempt: payload.attempt,
    contextAnswers: payload.contextAnswers ?? [],
    item: payload.item,
    preservedAnswers: payload.preservedAnswers ?? []
  };
}

async function loadGroupAttempt(
  sessionId: string,
  itemId: string,
  session: StudentCacheSession
) {
  const response = await fetch("/api/reading/wrongbook-attempts", {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ itemId, sessionId })
  });
  const payload = await response.json().catch(() => ({})) as AttemptPayload;
  if (!response.ok || payload.error || !payload.item || !isReadingWrongbookAttemptSummary(payload.attempt)) {
    throw new Error(payload.error ?? "错题订正记录加载失败，请稍后重试。");
  }
  return {
    attempt: payload.attempt,
    contextAnswers: payload.contextAnswers ?? [],
    item: payload.item,
    preservedAnswers: payload.preservedAnswers ?? []
  };
}

async function loadPractice(itemId: string, session: StudentCacheSession) {
  const response = await fetch(`/api/reading/practice/${encodeURIComponent(itemId)}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as PracticePayload;
  if (!response.ok || !payload.practice || payload.practice.item.itemId !== itemId) {
    throw new Error(payload.error ?? "阅读错题内容加载失败，请稍后重试。");
  }
  return payload;
}
