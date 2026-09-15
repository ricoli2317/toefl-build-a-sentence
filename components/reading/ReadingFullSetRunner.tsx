"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import {
  STUDENT_PRACTICE_HISTORY_CACHE_PREFIX,
  STUDENT_READING_FULL_SET_CACHE_PREFIX,
  useStudentDataCache
} from "@/components/StudentDataCache";
import {
  buildReadingSubmissionAnswers,
  type ReadingSubmittedAnswer
} from "@/lib/reading/attempts";
import {
  moveReadingFullSetPosition,
  isReadingFullSetBootstrapPayload,
  readingFullSetActiveModuleAttempt,
  readingFullSetAttemptPhase,
  readingFullSetCurrentModuleAttempt,
  readingFullSetDisplayRange,
  readingFullSetRemainingSeconds,
  readingFullSetRestoredPosition,
  readingFullSetRunnerModuleKey,
  type ReadingFullSetAttemptSummary,
  type ReadingFullSetOccurrencePracticePayload,
  type ReadingFullSetRunnerPayload,
  type ReadingFullSetRunnerPosition
} from "@/lib/reading/fullSetAttempts";
import {
  ReadingFullSetCursorQueue,
  type ReadingFullSetCursorSnapshot
} from "@/lib/reading/fullSetCursorQueue.client";
import { consumeReadingFullSetBootstrapHandoff } from "@/lib/reading/fullSetBootstrapHandoff.client";
import {
  setReadingAnswer,
  type ReadingAnswer,
  type ReadingAnswerState
} from "@/lib/reading/practiceState";
import { readingLookupEnabled } from "@/lib/reading/lookupCapabilities";
import { formatReadingFullSetTime } from "@/lib/reading/fullSetPresentation";
import {
  createReadingFullSetPerformanceTrace,
  fetchReadingFullSetWithTimeout,
  logReadingFullSetPerformancePhase,
  readingFullSetTraceHeaders,
  type ReadingFullSetPerformancePhase,
  type ReadingFullSetPerformanceTrace
} from "@/lib/reading/fullSetPerformance.client";
import {
  ReadingFullSetImagePreloadCache,
  ReadingFullSetOccurrenceCache,
  readingFullSetOccurrenceCacheKey,
  type ReadingFullSetCacheSource
} from "@/lib/reading/fullSetOccurrenceCache.client";
import {
  ReadingFullSetSaveError,
  ReadingFullSetSaveQueue,
  type ReadingFullSetSaveQueueEvent,
  type ReadingFullSetSaveSnapshot
} from "@/lib/reading/fullSetSaveQueue.client";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { invalidateStudentWrongbook } from "@/lib/studentCacheEvents";
import {
  ReadingPracticeHeader,
  ReadingQuestionViewport,
  ReadingWorkspaceRouter,
  readingTwoColumnScaleStyle
} from "./ReadingPractice";

type OccurrenceResponse = Partial<ReadingFullSetOccurrencePracticePayload> & { error?: string };
type AttemptResponse = { attempt?: ReadingFullSetAttemptSummary; error?: string };
type BootstrapResponse = {
  code?: string;
  error?: string;
  firstOccurrence?: ReadingFullSetOccurrencePracticePayload;
  runner?: ReadingFullSetRunnerPayload;
  traceId?: string;
};
type LoadPauseResponse = AttemptResponse & {
  expiresAt?: string;
  finished?: boolean;
  loadId?: string;
  reason?: "already_finished" | "expired" | "no_active_module";
  renewed?: boolean;
  started?: boolean;
};
type SaveResponse = {
  accepted?: boolean;
  answerRevision?: number;
  attempt?: ReadingFullSetAttemptSummary;
  error?: string;
  reason?: "locked" | "stale_revision" | "timed_out";
};
type CursorResponse = {
  accepted?: boolean;
  cursorRevision?: number;
  error?: string;
  reason?: "locked" | "stale_revision" | "timed_out";
};

type PendingSave = {
  answers: ReadingAnswerState;
  moduleAttemptId: string;
  moduleNumber: 1 | 2;
  occurrenceId: string;
  practice: ReadingFullSetOccurrencePracticePayload["practice"];
  taskType: "ctw" | "rap" | "rdl";
};

type BackgroundSave = {
  answers: ReadingSubmittedAnswer[];
  taskType: "ctw" | "rap" | "rdl";
  trace: ReadingFullSetPerformanceTrace;
};

type OccurrenceLoadState =
  | { status: "idle" }
  | { occurrenceId: string; status: "loading" }
  | { message: string; status: "error" };

type OccurrenceNavigation = {
  cacheStatus?: ReadingFullSetCacheSource;
  clickedAt: number;
  navigationAfterEnqueueAt?: number;
  occurrenceId: string;
  taskType: "ctw" | "rap" | "rdl";
  trace: ReadingFullSetPerformanceTrace;
  workspaceMounted?: boolean;
};

export function ReadingFullSetRunner({
  attemptId,
  expectedFullSetId
}: {
  attemptId: string;
  expectedFullSetId: string;
}) {
  const router = useRouter();
  const {
    getSession,
    invalidate,
    sessionReady,
    setData: setCachedData
  } = useStudentDataCache();
  const [accessToken, setAccessToken] = useState("");
  const studentIdRef = useRef("");
  const [runner, setRunner] = useState<ReadingFullSetRunnerPayload | null>(null);
  const runnerRef = useRef<ReadingFullSetRunnerPayload | null>(null);
  const [position, setPosition] = useState<ReadingFullSetRunnerPosition>({
    occurrenceIndex: 0,
    questionIndex: 0
  });
  const [occurrencePayloads, setOccurrencePayloads] = useState<Record<string, ReadingFullSetOccurrencePracticePayload>>({});
  const [answersByOccurrence, setAnswersByOccurrence] = useState<Record<string, ReadingAnswerState>>({});
  const answersRef = useRef<Record<string, ReadingAnswerState>>({});
  const questionTimesRef = useRef<Record<string, Record<string, number>>>({});
  const activeTimingRef = useRef<{ occurrenceId: string; questionId: string; startedAt: number } | null>(null);
  const revisionRef = useRef(0);
  const syncRef = useRef({ clientNowAtSyncMs: Date.now(), serverNow: "" });
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [loading, setLoading] = useState(true);
  const [timerPausedForLoad, setTimerPausedForLoad] = useState(false);
  const [occurrenceLoad, setOccurrenceLoad] = useState<OccurrenceLoadState>({ status: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [startingModule2, setStartingModule2] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const movingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<PendingSave | null>(null);
  const saveTransportRef = useRef<(snapshot: ReadingFullSetSaveSnapshot<BackgroundSave>) => Promise<void>>(
    async () => { throw new ReadingFullSetSaveError("答案保存尚未初始化。"); }
  );
  const saveEventRef = useRef<(event: ReadingFullSetSaveQueueEvent<BackgroundSave>) => void>(() => undefined);
  const saveQueueRef = useRef<ReadingFullSetSaveQueue<BackgroundSave> | null>(null);
  if (!saveQueueRef.current) {
    saveQueueRef.current = new ReadingFullSetSaveQueue<BackgroundSave>({
      maxRetries: 2,
      onEvent: (event) => saveEventRef.current(event),
      transport: (snapshot) => saveTransportRef.current(snapshot)
    });
  }
  const cursorTransportRef = useRef<(snapshot: ReadingFullSetCursorSnapshot) => Promise<void>>(
    async () => { throw new Error("题位保存尚未初始化。"); }
  );
  const cursorQueueRef = useRef<ReadingFullSetCursorQueue | null>(null);
  if (!cursorQueueRef.current) {
    cursorQueueRef.current = new ReadingFullSetCursorQueue({
      maxRetries: 1,
      transport: (snapshot) => cursorTransportRef.current(snapshot)
    });
  }
  const timeoutSubmitStartedRef = useRef(false);
  const timeoutRetryAfterRef = useRef(0);
  const runnerGenerationRef = useRef(0);
  const occurrenceRequestRef = useRef(0);
  const activeLoadPauseRef = useRef<{ expiresAt: string; loadId: string } | null>(null);
  const [activeLoadPause, setActiveLoadPause] = useState<{ expiresAt: string; loadId: string } | null>(null);
  const readyActionRef = useRef<string | null>(null);
  const transitionTraceRef = useRef<ReadingFullSetPerformanceTrace | null>(null);
  const transitionLoggedPhasesRef = useRef(new Set<ReadingFullSetPerformancePhase>());
  const occurrenceCacheRef = useRef(new ReadingFullSetOccurrenceCache<ReadingFullSetOccurrencePracticePayload>());
  const imagePreloadCacheRef = useRef(new ReadingFullSetImagePreloadCache());
  const imagePreloadStatusRef = useRef(new Map<string, "failed" | "hit" | "miss" | "not_applicable">());
  const prefetchTraceRef = useRef(new Map<string, ReadingFullSetPerformanceTrace>());
  const navigationRef = useRef<OccurrenceNavigation | null>(null);
  const [interactiveOccurrenceId, setInteractiveOccurrenceId] = useState("");

  const beginTransitionTrace = useCallback(() => {
    const trace = createReadingFullSetPerformanceTrace(attemptId);
    transitionTraceRef.current = trace;
    transitionLoggedPhasesRef.current = new Set();
    return trace;
  }, [attemptId]);

  const logTransitionPhase = useCallback((
    phase: ReadingFullSetPerformancePhase,
    input: Parameters<typeof logReadingFullSetPerformancePhase>[2],
    once = false
  ) => {
    const trace = transitionTraceRef.current;
    if (!trace || (once && transitionLoggedPhasesRef.current.has(phase))) return;
    if (once) transitionLoggedPhasesRef.current.add(phase);
    logReadingFullSetPerformancePhase(trace, phase, input);
  }, []);

  const updateActiveLoadPause = useCallback((pause: { expiresAt: string; loadId: string } | null) => {
    activeLoadPauseRef.current = pause;
    setActiveLoadPause(pause);
  }, []);

  const clearOccurrenceCaches = useCallback(() => {
    occurrenceCacheRef.current.clear();
    imagePreloadCacheRef.current.clear();
    imagePreloadStatusRef.current.clear();
    prefetchTraceRef.current.clear();
    navigationRef.current = null;
    setInteractiveOccurrenceId("");
  }, []);

  const applyRunner = useCallback((next: ReadingFullSetRunnerPayload) => {
    const previousModuleKey = runnerRef.current
      ? readingFullSetRunnerModuleKey(runnerRef.current.attempt)
      : null;
    const nextModuleKey = readingFullSetRunnerModuleKey(next.attempt);
    if (previousModuleKey !== nextModuleKey) {
      if (previousModuleKey) cursorQueueRef.current?.clear(previousModuleKey);
      clearOccurrenceCaches();
      runnerGenerationRef.current += 1;
      occurrenceRequestRef.current += 1;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      pendingSaveRef.current = null;
      setSaveError("");
      setOccurrencePayloads({});
      setAnswersByOccurrence({});
      answersRef.current = {};
      questionTimesRef.current = {};
      activeTimingRef.current = null;
      setPosition({ occurrenceIndex: 0, questionIndex: 0 });
      setOccurrenceLoad({ status: "idle" });
      movingRef.current = false;
      setNavigating(false);
    }
    runnerRef.current = next;
    setRunner(next);
    setCachedData(`reading:full-sets:attempt:${next.attempt.fullSetId}`, {
      attempt: next.attempt
    });
    if (next.attempt.status === "completed") {
      invalidate(`${STUDENT_READING_FULL_SET_CACHE_PREFIX}:catalog`);
      invalidate(STUDENT_PRACTICE_HISTORY_CACHE_PREFIX);
    }
    const moduleAttempt = readingFullSetCurrentModuleAttempt(next.attempt);
    if (moduleAttempt) {
      cursorQueueRef.current?.prime(moduleAttempt.moduleAttemptId, moduleAttempt.cursorRevision);
    }
    if (moduleAttempt?.status === "preparing") {
      revisionRef.current = moduleAttempt.answerRevision;
      setRemainingSeconds(moduleAttempt.timeLimitSeconds);
      timeoutSubmitStartedRef.current = false;
      timeoutRetryAfterRef.current = 0;
    } else if (moduleAttempt?.status === "active" && moduleAttempt.deadlineAt) {
      revisionRef.current = moduleAttempt.answerRevision;
      syncRef.current = {
        clientNowAtSyncMs: Date.now(),
        serverNow: next.attempt.serverNow
      };
      setRemainingSeconds(readingFullSetRemainingSeconds({
        clientNowAtSyncMs: syncRef.current.clientNowAtSyncMs,
        clientNowMs: Date.now(),
        deadlineAt: moduleAttempt.deadlineAt ?? syncRef.current.serverNow,
        serverNow: next.attempt.serverNow
      }));
      timeoutSubmitStartedRef.current = false;
      timeoutRetryAfterRef.current = 0;
    }
  }, [clearOccurrenceCaches, invalidate, setCachedData]);

  const applyBootstrap = useCallback((
    bootstrap: BootstrapResponse,
    moduleNumber: 1 | 2
  ) => {
    if (!isReadingFullSetBootstrapPayload(bootstrap)) {
      throw new Error(`Module ${moduleNumber} bootstrap 状态无效。`);
    }
    if (bootstrap.runner.attempt.fullSetId !== expectedFullSetId) {
      throw new Error("这次练习不属于当前套题。");
    }
    const occurrenceId = bootstrap.firstOccurrence.occurrence.occurrenceId;
    const occurrenceIndex = bootstrap.runner.occurrences.findIndex(
      (occurrence) => occurrence.occurrenceId === occurrenceId
    );
    if (occurrenceIndex < 0) throw new Error(`Module ${moduleNumber} 首题状态无效。`);
    applyRunner(bootstrap.runner);
    const occurrenceKey = readingFullSetOccurrenceCacheKey({
      attemptId,
      moduleNumber,
      occurrenceId
    });
    occurrenceCacheRef.current.prime(occurrenceKey, bootstrap.firstOccurrence);
    const imageUrl = bootstrap.firstOccurrence.occurrence.taskType === "rdl"
      ? bootstrap.firstOccurrence.practice.material?.imageUrl
      : null;
    if (imageUrl) {
      const preload = imagePreloadCacheRef.current.acquire(imageUrl);
      imagePreloadStatusRef.current.set(occurrenceKey, preload.source);
      void preload.promise.catch(() => {
        imagePreloadStatusRef.current.set(occurrenceKey, "failed");
      });
    } else {
      imagePreloadStatusRef.current.set(occurrenceKey, "not_applicable");
    }
    revisionRef.current = Math.max(revisionRef.current, bootstrap.firstOccurrence.answerRevision);
    const moduleAttempt = readingFullSetCurrentModuleAttempt(bootstrap.runner.attempt);
    if (!moduleAttempt) throw new Error(`Module ${moduleNumber} 状态无效。`);
    setPosition(readingFullSetRestoredPosition({
      moduleAttempt,
      occurrences: bootstrap.runner.occurrences,
      questionCount: bootstrap.firstOccurrence.practice.questions.length,
      restoredOccurrenceId: occurrenceId
    }));
    setOccurrencePayloads({ [occurrenceId]: bootstrap.firstOccurrence });
    setAnswersByOccurrence({ [occurrenceId]: bootstrap.firstOccurrence.answers });
    answersRef.current = { [occurrenceId]: bootstrap.firstOccurrence.answers };
    questionTimesRef.current = { [occurrenceId]: bootstrap.firstOccurrence.questionTimes };
    setOccurrenceLoad({ status: "idle" });
    if (!activeLoadPauseRef.current) setTimerPausedForLoad(false);
    logTransitionPhase(moduleNumber === 1 ? "m1_state_applied" : "m2_state_applied", {
      moduleNumber
    }, true);
  }, [applyRunner, attemptId, expectedFullSetId, logTransitionPhase]);

  const loadRunner = useCallback(async (token: string) => {
    const response = await fetchReadingFullSetWithTimeout(
      `/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}`,
      {
        cache: "no-store",
        headers: readingFullSetTraceHeaders(token, transitionTraceRef.current)
      },
      20_000
    );
    const payload = await response.json().catch(() => ({})) as BootstrapResponse;
    if (!response.ok || !payload.runner) {
      throw new Error(payload.error ?? "套题练习加载失败，请稍后重试。");
    }
    if (payload.runner.attempt.fullSetId !== expectedFullSetId) {
      throw new Error("这次练习不属于当前套题。");
    }
    const moduleAttempt = readingFullSetCurrentModuleAttempt(payload.runner.attempt);
    if (moduleAttempt && payload.firstOccurrence) {
      applyBootstrap(payload, moduleAttempt.moduleNumber);
    } else {
      applyRunner(payload.runner);
    }
    return payload.runner;
  }, [applyBootstrap, applyRunner, attemptId, expectedFullSetId]);

  const applyAttempt = useCallback((attempt: ReadingFullSetAttemptSummary) => {
    const current = runnerRef.current;
    if (current) {
      const moduleChanged = readingFullSetRunnerModuleKey(current.attempt)
        !== readingFullSetRunnerModuleKey(attempt);
      applyRunner({ ...current, attempt, occurrences: moduleChanged ? [] : current.occurrences });
    }
  }, [applyRunner]);

  const finishLoadPause = useCallback(async (token: string, loadId: string) => {
    let lastError: Error | null = null;
    for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
      try {
        const response = await fetch(
          `/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}/loads/${encodeURIComponent(loadId)}`,
          { method: "PUT", cache: "no-store", headers: { Authorization: `Bearer ${token}` } }
        );
        const payload = await response.json().catch(() => ({})) as LoadPauseResponse;
        if (!response.ok || !payload.finished || !payload.attempt) {
          throw new Error(payload.error ?? "题目加载计时同步失败，请重试。");
        }
        applyAttempt(payload.attempt);
        if (activeLoadPauseRef.current?.loadId === loadId) updateActiveLoadPause(null);
        return;
      } catch (finishError) {
        lastError = finishError instanceof Error
          ? finishError
          : new Error("题目加载计时同步失败，请重试。");
        if (attemptNumber === 0) await wait(500);
      }
    }
    throw lastError ?? new Error("题目加载计时同步失败，请重试。");
  }, [applyAttempt, attemptId, updateActiveLoadPause]);

  const beginLoadPause = useCallback(async (token: string, occurrenceId: string | null) => {
    setTimerPausedForLoad(true);
    const loadId = crypto.randomUUID();
    const response = await fetch(
      `/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}/loads`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ loadId, occurrenceId })
      }
    );
    const payload = await response.json().catch(() => ({})) as LoadPauseResponse;
    if (!response.ok || typeof payload.started !== "boolean" || !payload.attempt) {
      setTimerPausedForLoad(false);
      throw new Error(payload.error ?? "题目加载计时同步失败，请重试。");
    }
    applyAttempt(payload.attempt);
    if (!payload.started) {
      setTimerPausedForLoad(false);
      if (payload.reason === "no_active_module") return null;
      throw new Error("题目加载失败，请重试。");
    }
    if (!payload.loadId || !payload.expiresAt) {
      setTimerPausedForLoad(false);
      throw new Error("题目加载计时同步失败，请重试。");
    }
    const activePause = { expiresAt: payload.expiresAt, loadId: payload.loadId };
    updateActiveLoadPause(activePause);
    return activePause;
  }, [applyAttempt, attemptId, updateActiveLoadPause]);

  useEffect(() => {
    if (!accessToken || !activeLoadPause) return;
    let stopped = false;
    const renew = async () => {
      try {
        const response = await fetch(
          `/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}/loads/${encodeURIComponent(activeLoadPause.loadId)}`,
          { method: "PATCH", cache: "no-store", headers: { Authorization: `Bearer ${accessToken}` } }
        );
        const payload = await response.json().catch(() => ({})) as LoadPauseResponse;
        if (stopped || !response.ok || typeof payload.renewed !== "boolean" || !payload.attempt) return;
        applyAttempt(payload.attempt);
        if (
          payload.renewed
          && payload.loadId
          && payload.expiresAt
          && activeLoadPauseRef.current?.loadId === activeLoadPause.loadId
        ) {
          updateActiveLoadPause({ expiresAt: payload.expiresAt, loadId: payload.loadId });
        } else if (activeLoadPauseRef.current?.loadId === activeLoadPause.loadId) {
          updateActiveLoadPause(null);
          setTimerPausedForLoad(false);
        }
      } catch {
        // Transient failures retry on the next heartbeat. If heartbeats stop,
        // the server-issued 45-second TTL ends the protected interval.
      }
    };
    const heartbeat = window.setInterval(() => void renew(), 15_000);
    return () => {
      stopped = true;
      window.clearInterval(heartbeat);
    };
  }, [accessToken, activeLoadPause, applyAttempt, attemptId, updateActiveLoadPause]);

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, []);

  useEffect(() => {
    if (!sessionReady) return;
    let cancelled = false;
    void (async () => {
      let initialPause: { expiresAt: string; loadId: string } | null = null;
      let token = "";
      try {
        const session = getSession();
        if (!session) throw new Error("请先登录后再开始套题练习。");
        if (cancelled) return;
        token = session.accessToken;
        studentIdRef.current = session.studentId;
        setAccessToken(token);
        const handoff = consumeReadingFullSetBootstrapHandoff({ attemptId, expectedFullSetId });
        if (handoff) {
          transitionTraceRef.current = handoff.trace;
          transitionLoggedPhasesRef.current = new Set();
          applyBootstrap(handoff, 1);
          return;
        }
        initialPause = await beginLoadPause(token, null);
        if (cancelled) {
          if (initialPause) await finishLoadPause(token, initialPause.loadId);
          return;
        }
        await loadRunner(token);
      } catch (loadError) {
        if (initialPause && token) {
          await finishLoadPause(token, initialPause.loadId).catch(() => undefined);
        }
        updateActiveLoadPause(null);
        setTimerPausedForLoad(false);
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "套题练习加载失败，请稍后重试。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [applyBootstrap, attemptId, beginLoadPause, expectedFullSetId, finishLoadPause, getSession, loadRunner, sessionReady, updateActiveLoadPause]);

  useEffect(() => () => {
    occurrenceCacheRef.current.clear();
    imagePreloadCacheRef.current.clear();
    prefetchTraceRef.current.clear();
  }, []);

  const currentOccurrence = runner?.occurrences[position.occurrenceIndex] ?? null;
  const currentPayload = currentOccurrence
    ? occurrencePayloads[currentOccurrence.occurrenceId] ?? null
    : null;
  const currentQuestion = currentPayload?.practice.questions[position.questionIndex];

  const acquireOccurrence = useCallback((input: {
    moduleNumber: 1 | 2;
    occurrence: ReadingFullSetRunnerPayload["occurrences"][number];
    prefetch: boolean;
    retryError?: boolean;
    trace: ReadingFullSetPerformanceTrace;
  }) => {
    const key = readingFullSetOccurrenceCacheKey({
      attemptId,
      moduleNumber: input.moduleNumber,
      occurrenceId: input.occurrence.occurrenceId
    });
    const route = `/api/reading/full-set-attempts/${attemptId}/occurrences/${input.occurrence.occurrenceId}`;
    return occurrenceCacheRef.current.acquire(key, async (signal) => {
      const contentStartedAt = performance.now();
      const response = await fetch(
        `/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}/occurrences/${encodeURIComponent(input.occurrence.occurrenceId)}`,
        {
          cache: "no-store",
          headers: readingFullSetTraceHeaders(accessToken, input.trace),
          signal
        }
      );
      const payload = await response.json().catch(() => ({})) as OccurrenceResponse;
      if (!response.ok || !payload.practice || !payload.occurrence || !payload.answers || !Number.isInteger(payload.answerRevision)) {
        throw new Error(payload.error ?? "题目加载失败，请重试。");
      }
      const completePayload = payload as ReadingFullSetOccurrencePracticePayload;
      if (input.prefetch) {
        logReadingFullSetPerformancePhase(input.trace, "next_prefetch_content_end", {
          durationMs: performance.now() - contentStartedAt,
          moduleNumber: input.moduleNumber,
          occurrenceId: input.occurrence.occurrenceId,
          route,
          taskType: input.occurrence.taskType
        });
      }

      const imageUrl = input.occurrence.taskType === "rdl"
        ? completePayload.practice.material?.imageUrl
        : null;
      if (imageUrl) {
        const imageStartedAt = performance.now();
        const image = imagePreloadCacheRef.current.acquire(imageUrl);
        imagePreloadStatusRef.current.set(key, image.source);
        logReadingFullSetPerformancePhase(input.trace, "rdl_image_preload_start", {
          imagePreloadStatus: image.source,
          moduleNumber: input.moduleNumber,
          occurrenceId: input.occurrence.occurrenceId,
          taskType: input.occurrence.taskType
        });
        try {
          await image.promise;
          logReadingFullSetPerformancePhase(input.trace, "rdl_image_preload_end", {
            durationMs: performance.now() - imageStartedAt,
            imagePreloadStatus: image.source,
            moduleNumber: input.moduleNumber,
            occurrenceId: input.occurrence.occurrenceId,
            taskType: input.occurrence.taskType
          });
        } catch (error) {
          imagePreloadStatusRef.current.set(key, "failed");
          logReadingFullSetPerformancePhase(input.trace, "rdl_image_preload_end", {
            durationMs: performance.now() - imageStartedAt,
            failure: error instanceof DOMException && error.name === "AbortError"
              ? "IMAGE_PRELOAD_ABORTED"
              : "IMAGE_PRELOAD_FAILED",
            imagePreloadStatus: "failed",
            moduleNumber: input.moduleNumber,
            occurrenceId: input.occurrence.occurrenceId,
            success: false,
            taskType: input.occurrence.taskType
          });
        }
      } else {
        imagePreloadStatusRef.current.set(key, "not_applicable");
      }
      if (input.prefetch) {
        logReadingFullSetPerformancePhase(input.trace, "next_prefetch_ready", {
          imagePreloadStatus: imagePreloadStatusRef.current.get(key) ?? "not_applicable",
          moduleNumber: input.moduleNumber,
          occurrenceId: input.occurrence.occurrenceId,
          taskType: input.occurrence.taskType
        });
      }
      return completePayload;
    }, { retryError: input.retryError, timeoutMs: 15_000 });
  }, [accessToken, attemptId]);

  const applyOccurrencePayload = useCallback((completePayload: ReadingFullSetOccurrencePracticePayload) => {
    const occurrenceId = completePayload.occurrence.occurrenceId;
    revisionRef.current = Math.max(revisionRef.current, completePayload.answerRevision);
    setOccurrencePayloads((current) => current[occurrenceId]
      ? current
      : { ...current, [occurrenceId]: completePayload });
    setAnswersByOccurrence((current) => {
      if (Object.prototype.hasOwnProperty.call(current, occurrenceId)) return current;
      const next = { ...current, [occurrenceId]: completePayload.answers };
      answersRef.current = next;
      return next;
    });
    if (!Object.prototype.hasOwnProperty.call(questionTimesRef.current, occurrenceId)) {
      questionTimesRef.current = {
        ...questionTimesRef.current,
        [occurrenceId]: completePayload.questionTimes
      };
    }
  }, []);

  useEffect(() => {
    if (
      currentOccurrence?.taskType === "ctw"
      && currentPayload
      && runner
    ) {
      const phase = readingFullSetAttemptPhase(runner.attempt);
      if (phase === "module_1_preparing" || phase === "module_1_active") {
        logTransitionPhase("m1_first_ctw_mounted", { moduleNumber: 1 }, true);
      } else if (phase === "module_2_preparing" || phase === "module_2_active") {
        logTransitionPhase("m2_first_ctw_mounted", { moduleNumber: 2 }, true);
      }
    }
  }, [currentOccurrence, currentPayload, logTransitionPhase, runner]);

  useEffect(() => {
    const navigation = navigationRef.current;
    const moduleAttempt = runner ? readingFullSetCurrentModuleAttempt(runner.attempt) : null;
    if (
      !currentPayload
      || !currentOccurrence
      || !moduleAttempt
      || !navigation
      || navigation.workspaceMounted
      || navigation.occurrenceId !== currentOccurrence.occurrenceId
    ) return;
    navigation.workspaceMounted = true;
    logReadingFullSetPerformancePhase(navigation.trace, "next_workspace_mounted", {
      cacheStatus: navigation.cacheStatus,
      durationMs: navigation.navigationAfterEnqueueAt
        ? performance.now() - navigation.navigationAfterEnqueueAt
        : undefined,
      moduleNumber: moduleAttempt.moduleNumber,
      occurrenceId: currentOccurrence.occurrenceId,
      taskType: currentOccurrence.taskType,
      totalDurationMs: performance.now() - navigation.clickedAt
    });
  }, [currentOccurrence, currentPayload, runner]);

  useEffect(() => {
    if (!accessToken || !currentOccurrence || currentPayload) return;
    const requestId = occurrenceRequestRef.current + 1;
    occurrenceRequestRef.current = requestId;
    const generation = runnerGenerationRef.current;
    let pause = activeLoadPauseRef.current;
    setOccurrenceLoad({ occurrenceId: currentOccurrence.occurrenceId, status: "loading" });

    void (async () => {
      try {
        const moduleAttempt = runnerRef.current
          ? readingFullSetCurrentModuleAttempt(runnerRef.current.attempt)
          : null;
        if (!moduleAttempt || moduleAttempt.status === "submitted") throw new Error("当前 Module 已结束。");
        const key = readingFullSetOccurrenceCacheKey({
          attemptId,
          moduleNumber: moduleAttempt.moduleNumber,
          occurrenceId: currentOccurrence.occurrenceId
        });
        const navigation = navigationRef.current?.occurrenceId === currentOccurrence.occurrenceId
          ? navigationRef.current
          : null;
        const trace = navigation?.trace
          ?? prefetchTraceRef.current.get(key)
          ?? createReadingFullSetPerformanceTrace(attemptId);
        const cachedStatus = occurrenceCacheRef.current.status(key);
        const navigationSource: ReadingFullSetCacheSource = cachedStatus === "ready"
          ? "hit"
          : cachedStatus === "loading"
            ? "wait"
            : "miss";
        if (navigation) {
          navigation.cacheStatus = navigationSource;
          logReadingFullSetPerformancePhase(trace, `navigation_cache_${navigationSource}`, {
            cacheStatus: navigationSource,
            imagePreloadStatus: imagePreloadStatusRef.current.get(key) ?? "not_applicable",
            moduleNumber: moduleAttempt.moduleNumber,
            occurrenceId: currentOccurrence.occurrenceId,
            taskType: currentOccurrence.taskType
          });
        }
        if (moduleAttempt.status === "active" && navigationSource !== "hit" && !pause) {
          setTimerPausedForLoad(true);
          pause = await beginLoadPause(accessToken, currentOccurrence.occurrenceId);
        }
        if (moduleAttempt.status === "active" && navigationSource !== "hit" && !pause) {
          throw new Error("题目加载失败，请重试。");
        }
        let acquisition = acquireOccurrence({
          moduleNumber: moduleAttempt.moduleNumber,
          occurrence: currentOccurrence,
          prefetch: false,
          retryError: true,
          trace
        });
        if (navigation && navigationSource === "wait" && acquisition.source === "miss") {
          navigation.cacheStatus = "miss";
          logReadingFullSetPerformancePhase(trace, "navigation_cache_miss", {
            cacheStatus: "miss",
            moduleNumber: moduleAttempt.moduleNumber,
            occurrenceId: currentOccurrence.occurrenceId,
            taskType: currentOccurrence.taskType
          });
        }
        let completePayload: ReadingFullSetOccurrencePracticePayload;
        try {
          completePayload = await acquisition.promise;
        } catch (prefetchError) {
          if (acquisition.source !== "wait") throw prefetchError;
          acquisition = acquireOccurrence({
            moduleNumber: moduleAttempt.moduleNumber,
            occurrence: currentOccurrence,
            prefetch: false,
            retryError: true,
            trace
          });
          if (navigation) {
            navigation.cacheStatus = "miss";
            logReadingFullSetPerformancePhase(trace, "navigation_cache_miss", {
              cacheStatus: "miss",
              moduleNumber: moduleAttempt.moduleNumber,
              occurrenceId: currentOccurrence.occurrenceId,
              taskType: currentOccurrence.taskType
            });
          }
          completePayload = await acquisition.promise;
        }
        if (requestId !== occurrenceRequestRef.current || generation !== runnerGenerationRef.current) return;
        applyOccurrencePayload(completePayload);
      } catch {
        if (pause) await finishLoadPause(accessToken, pause.loadId).catch(() => undefined);
        updateActiveLoadPause(null);
        if (requestId !== occurrenceRequestRef.current || generation !== runnerGenerationRef.current) return;
        const failedNavigation = navigationRef.current;
        if (failedNavigation?.occurrenceId === currentOccurrence.occurrenceId) {
          if (transitionTraceRef.current?.traceId === failedNavigation.trace.traceId) {
            transitionTraceRef.current = null;
          }
          navigationRef.current = null;
        }
        movingRef.current = false;
        setNavigating(false);
        setTimerPausedForLoad(false);
        setOccurrenceLoad({ message: "题目加载失败，请重试。", status: "error" });
      }
    })();
  }, [accessToken, acquireOccurrence, applyOccurrencePayload, attemptId, beginLoadPause, currentOccurrence, currentPayload, finishLoadPause, updateActiveLoadPause]);

  const handleWorkspaceReady = useCallback(() => {
    const activeRunner = runnerRef.current;
    const occurrence = activeRunner?.occurrences[position.occurrenceIndex];
    const moduleAttempt = activeRunner
      ? readingFullSetCurrentModuleAttempt(activeRunner.attempt)
      : null;
    if (!accessToken || !occurrence || !moduleAttempt || moduleAttempt.status === "submitted") return;
    const readyKey = `${runnerGenerationRef.current}:${moduleAttempt.moduleAttemptId}:${occurrence.occurrenceId}`;
    if (readyActionRef.current === readyKey) return;
    readyActionRef.current = readyKey;
    const mountedNavigation = navigationRef.current;
    if (mountedNavigation?.occurrenceId === occurrence.occurrenceId && !mountedNavigation.workspaceMounted) {
      mountedNavigation.workspaceMounted = true;
      logReadingFullSetPerformancePhase(mountedNavigation.trace, "next_workspace_mounted", {
        cacheStatus: mountedNavigation.cacheStatus,
        durationMs: mountedNavigation.navigationAfterEnqueueAt
          ? performance.now() - mountedNavigation.navigationAfterEnqueueAt
          : undefined,
        moduleNumber: moduleAttempt.moduleNumber,
        occurrenceId: occurrence.occurrenceId,
        taskType: occurrence.taskType,
        totalDurationMs: performance.now() - mountedNavigation.clickedAt
      });
    }
    void (async () => {
      try {
        if (moduleAttempt.status === "preparing") {
          const isModule2 = moduleAttempt.moduleNumber === 2;
          const prefix = isModule2 ? "m2" : "m1";
          logTransitionPhase(`${prefix}_first_ctw_mounted`, {
            moduleNumber: moduleAttempt.moduleNumber
          }, true);
          logTransitionPhase(`${prefix}_first_interactive`, {
            moduleNumber: moduleAttempt.moduleNumber
          }, true);
          logTransitionPhase(`${prefix}_activation_start`, {
            moduleNumber: moduleAttempt.moduleNumber,
            route: `/api/reading/full-set-attempts/${attemptId}/modules/${moduleAttempt.moduleNumber}/activate`
          }, true);
          const activationStartedAt = performance.now();
          const response = await fetchReadingFullSetWithTimeout(
            `/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}/modules/${moduleAttempt.moduleNumber}/activate`,
            {
              method: "POST",
              cache: "no-store",
              headers: readingFullSetTraceHeaders(accessToken, transitionTraceRef.current)
            },
            12_000
          );
          const payload = await response.json().catch(() => ({})) as AttemptResponse;
          if (!response.ok || !payload.attempt) {
            throw new Error(payload.error ?? "Module 计时启动失败，请重试。");
          }
          applyAttempt(payload.attempt);
          logTransitionPhase(`${prefix}_activation_end`, {
            durationMs: performance.now() - activationStartedAt,
            moduleNumber: moduleAttempt.moduleNumber,
            route: `/api/reading/full-set-attempts/${attemptId}/modules/${moduleAttempt.moduleNumber}/activate`
          }, true);
          requestAnimationFrame(() => {
            logTransitionPhase(`${prefix}_countdown_active`, {
              moduleNumber: moduleAttempt.moduleNumber
            }, true);
          });
        } else {
          const pause = activeLoadPauseRef.current;
          if (pause) await finishLoadPause(accessToken, pause.loadId);
        }
        setOccurrenceLoad({ status: "idle" });
        setTimerPausedForLoad(false);
        setError("");
        setInteractiveOccurrenceId(occurrence.occurrenceId);
        const navigation = navigationRef.current;
        if (navigation?.occurrenceId === occurrence.occurrenceId) {
          const key = readingFullSetOccurrenceCacheKey({
            attemptId,
            moduleNumber: moduleAttempt.moduleNumber,
            occurrenceId: occurrence.occurrenceId
          });
          logReadingFullSetPerformancePhase(navigation.trace, "next_first_interactive", {
            cacheStatus: navigation.cacheStatus,
            durationMs: performance.now() - navigation.clickedAt,
            imagePreloadStatus: imagePreloadStatusRef.current.get(key) ?? "not_applicable",
            moduleNumber: moduleAttempt.moduleNumber,
            occurrenceId: occurrence.occurrenceId,
            taskType: occurrence.taskType,
            totalDurationMs: performance.now() - navigation.clickedAt
          });
          if (transitionTraceRef.current?.traceId === navigation.trace.traceId) {
            transitionTraceRef.current = null;
          }
          navigationRef.current = null;
        }
        movingRef.current = false;
        setNavigating(false);
      } catch (readyError) {
        if (moduleAttempt.status === "preparing") {
          logTransitionPhase(moduleAttempt.moduleNumber === 2 ? "m2_activation_end" : "m1_activation_end", {
            failure: readyError instanceof Error && readyError.name === "ReadingFullSetRequestTimeout"
              ? "ACTIVATION_FAILED"
              : readyError instanceof DOMException && readyError.name === "AbortError"
                ? "NETWORK_ABORT"
                : "ACTIVATION_FAILED",
            moduleNumber: moduleAttempt.moduleNumber,
            route: `/api/reading/full-set-attempts/${attemptId}/modules/${moduleAttempt.moduleNumber}/activate`,
            success: false
          });
        }
        readyActionRef.current = null;
        const failedNavigation = navigationRef.current;
        if (failedNavigation?.occurrenceId === occurrence.occurrenceId) {
          if (transitionTraceRef.current?.traceId === failedNavigation.trace.traceId) {
            transitionTraceRef.current = null;
          }
          navigationRef.current = null;
        }
        updateActiveLoadPause(null);
        setTimerPausedForLoad(false);
        setError(readyError instanceof Error ? readyError.message : "Module 计时同步失败，请重试。");
        setOccurrenceLoad({ message: "题目加载失败，请重试。", status: "error" });
        movingRef.current = false;
        setNavigating(false);
      }
    })();
  }, [accessToken, applyAttempt, attemptId, finishLoadPause, logTransitionPhase, position.occurrenceIndex, updateActiveLoadPause]);

  useEffect(() => {
    if (
      !accessToken
      || !runner
      || !currentOccurrence
      || !currentPayload
      || interactiveOccurrenceId !== currentOccurrence.occurrenceId
    ) return;
    const moduleAttempt = readingFullSetActiveModuleAttempt(runner.attempt);
    const nextOccurrence = runner.occurrences[position.occurrenceIndex + 1];
    if (!moduleAttempt || !nextOccurrence) return;
    const key = readingFullSetOccurrenceCacheKey({
      attemptId,
      moduleNumber: moduleAttempt.moduleNumber,
      occurrenceId: nextOccurrence.occurrenceId
    });
    if (occurrenceCacheRef.current.status(key) !== "idle") return;

    const trace = transitionTraceRef.current ?? createReadingFullSetPerformanceTrace(attemptId);
    if (transitionTraceRef.current?.traceId === trace.traceId) {
      transitionTraceRef.current = null;
    }
    prefetchTraceRef.current.set(key, trace);
    logReadingFullSetPerformancePhase(trace, "next_prefetch_start", {
      moduleNumber: moduleAttempt.moduleNumber,
      occurrenceId: nextOccurrence.occurrenceId,
      taskType: nextOccurrence.taskType
    });
    const acquisition = acquireOccurrence({
      moduleNumber: moduleAttempt.moduleNumber,
      occurrence: nextOccurrence,
      prefetch: true,
      retryError: false,
      trace
    });
    void acquisition.promise.catch((prefetchError) => {
      logReadingFullSetPerformancePhase(trace, "next_prefetch_ready", {
        failure: prefetchError instanceof DOMException && prefetchError.name === "AbortError"
          ? "PREFETCH_ABORTED"
          : "PREFETCH_FAILED",
        moduleNumber: moduleAttempt.moduleNumber,
        occurrenceId: nextOccurrence.occurrenceId,
        success: false,
        taskType: nextOccurrence.taskType
      });
    });
  }, [accessToken, acquireOccurrence, attemptId, currentOccurrence, currentPayload, interactiveOccurrenceId, position.occurrenceIndex, runner]);

  const commitActiveQuestionTime = useCallback(() => {
    const active = activeTimingRef.current;
    if (!active) return;
    const elapsed = Math.max(0, Math.round((Date.now() - active.startedAt) / 1000));
    const occurrenceTimes = questionTimesRef.current[active.occurrenceId] ?? {};
    questionTimesRef.current = {
      ...questionTimesRef.current,
      [active.occurrenceId]: {
        ...occurrenceTimes,
        [active.questionId]: (occurrenceTimes[active.questionId] ?? 0) + elapsed
      }
    };
    activeTimingRef.current = { ...active, startedAt: Date.now() };
  }, []);

  const snapshotQuestionTimes = useCallback((occurrenceId: string) => {
    const times = { ...(questionTimesRef.current[occurrenceId] ?? {}) };
    const active = activeTimingRef.current;
    if (active?.occurrenceId === occurrenceId) {
      times[active.questionId] = (times[active.questionId] ?? 0)
        + Math.max(0, Math.round((Date.now() - active.startedAt) / 1000));
    }
    return times;
  }, []);

  useEffect(() => {
    const activeModule = runner ? readingFullSetActiveModuleAttempt(runner.attempt) : null;
    if (!currentOccurrence || !currentQuestion || !activeModule || occurrenceLoad.status !== "idle") return;
    const active = activeTimingRef.current;
    if (active?.occurrenceId === currentOccurrence.occurrenceId && active.questionId === currentQuestion.questionId) return;
    commitActiveQuestionTime();
    activeTimingRef.current = {
      occurrenceId: currentOccurrence.occurrenceId,
      questionId: currentQuestion.questionId,
      startedAt: Date.now()
    };
  }, [commitActiveQuestionTime, currentOccurrence, currentQuestion, occurrenceLoad.status, runner]);

  const persistSave = useCallback(async (snapshot: ReadingFullSetSaveSnapshot<BackgroundSave>) => {
    const activeRunner = runnerRef.current;
    if (!accessToken || !activeRunner) {
      throw new ReadingFullSetSaveError("答案保存尚未准备好。");
    }
    if (readingFullSetRunnerModuleKey(activeRunner.attempt) !== snapshot.moduleAttemptId) {
      throw new ReadingFullSetSaveError("当前 Module 已结束，答案不能再修改。");
    }
    let response: Response;
    try {
      response = await fetch(
        `/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}/occurrences/${encodeURIComponent(snapshot.occurrenceId)}`,
        {
          method: "PUT",
          cache: "no-store",
          keepalive: true,
          headers: {
            ...readingFullSetTraceHeaders(accessToken, snapshot.value.trace),
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            answers: snapshot.value.answers,
            expectedRevision: revisionRef.current,
            moduleNumber: snapshot.moduleNumber
          })
        }
      );
    } catch (error) {
      throw new ReadingFullSetSaveError("答案保存失败，请检查网络后重试。", {
        cause: error,
        retryable: true
      });
    }
    const result = await response.json().catch(() => ({})) as SaveResponse;
    if (result.attempt) applyAttempt(result.attempt);
    if (!response.ok || !result.accepted || !Number.isInteger(result.answerRevision)) {
      const message = result.reason === "timed_out" || result.reason === "locked"
        ? "当前 Module 已结束，答案不能再修改。"
        : result.reason === "stale_revision"
          ? "答案状态已在其他页面更新，请刷新后继续。"
          : result.error ?? "答案保存失败，请检查网络后重试。";
      throw new ReadingFullSetSaveError(message, {
        retryable: response.status === 408
          || response.status === 429
          || response.status >= 500
      });
    }
    if (readingFullSetRunnerModuleKey(runnerRef.current?.attempt ?? activeRunner.attempt) !== snapshot.moduleAttemptId) {
      throw new ReadingFullSetSaveError("当前 Module 已结束，答案不能再修改。");
    }
    revisionRef.current = Math.max(revisionRef.current, Number(result.answerRevision));
  }, [accessToken, applyAttempt, attemptId]);

  saveTransportRef.current = persistSave;
  saveEventRef.current = (event) => {
    const { snapshot } = event;
    const phase = event.type === "enqueued"
      ? "background_save_enqueued"
      : event.type === "started"
        ? "background_save_started"
        : event.type === "success"
          ? "background_save_success"
          : event.type === "retry"
            ? "background_save_retry"
            : "background_save_error";
    logReadingFullSetPerformancePhase(snapshot.value.trace, phase, {
      durationMs: event.durationMs,
      failure: event.error instanceof Error ? event.error.name : event.error ? "ANSWER_SAVE_FAILED" : null,
      moduleNumber: snapshot.moduleNumber,
      occurrenceId: snapshot.occurrenceId,
      success: event.type !== "error",
      taskType: snapshot.value.taskType
    });
    if (event.type === "error") {
      setSaveError(event.error instanceof Error
        ? event.error.message
        : "答案保存失败，请检查网络后重试。");
    } else if (event.type === "success" && !saveQueueRef.current?.hasErrors(snapshot.moduleAttemptId)) {
      setSaveError("");
    }
  };

  const persistCursor = useCallback(async (snapshot: ReadingFullSetCursorSnapshot) => {
    const activeRunner = runnerRef.current;
    if (!accessToken || !activeRunner) throw new Error("题位保存尚未准备好。");
    const moduleAttempt = readingFullSetActiveModuleAttempt(activeRunner.attempt);
    if (!moduleAttempt || moduleAttempt.moduleAttemptId !== snapshot.moduleAttemptId) return;
    const response = await fetch(
      `/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}/modules/${snapshot.moduleNumber}/cursor`,
      {
        method: "PUT",
        cache: "no-store",
        keepalive: true,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          cursorRevision: snapshot.cursorRevision,
          occurrenceId: snapshot.occurrenceId,
          questionIndex: snapshot.questionIndex
        })
      }
    );
    const result = await response.json().catch(() => ({})) as CursorResponse;
    if (!response.ok || typeof result.accepted !== "boolean" || !Number.isInteger(result.cursorRevision)) {
      throw new Error(result.error ?? "套题题位保存失败。");
    }
    cursorQueueRef.current?.prime(snapshot.moduleAttemptId, Number(result.cursorRevision));
  }, [accessToken, attemptId]);

  cursorTransportRef.current = persistCursor;

  const enqueueCursor = useCallback((
    moduleAttempt: NonNullable<ReturnType<typeof readingFullSetActiveModuleAttempt>>,
    occurrenceId: string,
    questionIndex: number
  ) => cursorQueueRef.current!.enqueue({
    moduleAttemptId: moduleAttempt.moduleAttemptId,
    moduleNumber: moduleAttempt.moduleNumber,
    occurrenceId,
    questionIndex
  }), []);

  const enqueuePendingSave = useCallback((pending: PendingSave, trace?: ReadingFullSetPerformanceTrace | null) => {
    const saveTrace = trace ?? createReadingFullSetPerformanceTrace(attemptId);
    const answers = buildReadingSubmissionAnswers(
      pending.practice,
      pending.answers,
      snapshotQuestionTimes(pending.occurrenceId)
    );
    logReadingFullSetPerformancePhase(saveTrace, "answer_snapshot_created", {
      moduleNumber: pending.moduleNumber,
      occurrenceId: pending.occurrenceId,
      taskType: pending.taskType
    });
    return saveQueueRef.current!.enqueue({
      key: `${attemptId}:${pending.moduleAttemptId}:${pending.occurrenceId}`,
      moduleAttemptId: pending.moduleAttemptId,
      moduleNumber: pending.moduleNumber,
      occurrenceId: pending.occurrenceId,
      value: { answers, taskType: pending.taskType, trace: saveTrace }
    });
  }, [attemptId, snapshotQuestionTimes]);

  const stageCurrentOccurrenceSave = useCallback((trace?: ReadingFullSetPerformanceTrace | null) => {
    if (!currentOccurrence || !currentPayload || !runner) return null;
    const moduleAttempt = readingFullSetActiveModuleAttempt(runner.attempt);
    if (!moduleAttempt) return null;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    pendingSaveRef.current = null;
    return enqueuePendingSave({
      answers: answersRef.current[currentOccurrence.occurrenceId] ?? {},
      moduleAttemptId: moduleAttempt.moduleAttemptId,
      moduleNumber: moduleAttempt.moduleNumber,
      occurrenceId: currentOccurrence.occurrenceId,
      practice: currentPayload.practice,
      taskType: currentOccurrence.taskType
    }, trace);
  }, [currentOccurrence, currentPayload, enqueuePendingSave, runner]);

  const flushPendingSave = useCallback(async (
    moduleAttemptId?: string,
    moduleNumber?: 1 | 2,
    trace?: ReadingFullSetPerformanceTrace | null
  ) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pending) enqueuePendingSave(pending, trace);
    const activeModule = runnerRef.current
      ? readingFullSetCurrentModuleAttempt(runnerRef.current.attempt)
      : null;
    const targetModuleAttemptId = moduleAttemptId ?? activeModule?.moduleAttemptId;
    const targetModuleNumber = moduleNumber ?? activeModule?.moduleNumber;
    if (!targetModuleAttemptId || !targetModuleNumber) return true;
    const flushTrace = trace ?? createReadingFullSetPerformanceTrace(attemptId);
    const startedAt = performance.now();
    logReadingFullSetPerformancePhase(flushTrace, "durability_flush_start", {
      moduleNumber: targetModuleNumber
    });
    const saved = await saveQueueRef.current!.flush(targetModuleAttemptId);
    logReadingFullSetPerformancePhase(flushTrace, "durability_flush_end", {
      durationMs: performance.now() - startedAt,
      failure: saved ? null : "ANSWER_SAVE_FAILED",
      moduleNumber: targetModuleNumber,
      success: saved
    });
    return saved;
  }, [attemptId, enqueuePendingSave]);

  useEffect(() => {
    if (!currentOccurrence || !currentPayload) return;
    const timer = window.setInterval(() => {
      if (submittingRef.current) return;
      commitActiveQuestionTime();
      stageCurrentOccurrenceSave();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [commitActiveQuestionTime, currentOccurrence, currentPayload, flushPendingSave, stageCurrentOccurrenceSave]);

  const updateAnswer = useCallback((questionId: string, answer: ReadingAnswer) => {
    if (!currentOccurrence || !currentPayload || !runner || submittingRef.current) return;
    const moduleAttempt = readingFullSetActiveModuleAttempt(runner.attempt);
    if (!moduleAttempt) return;
    setAnswersByOccurrence((current) => {
      const occurrenceAnswers = current[currentOccurrence.occurrenceId] ?? {};
      const nextOccurrenceAnswers = setReadingAnswer(occurrenceAnswers, questionId, answer);
      const next = { ...current, [currentOccurrence.occurrenceId]: nextOccurrenceAnswers };
      answersRef.current = next;
      pendingSaveRef.current = {
        answers: nextOccurrenceAnswers,
        moduleAttemptId: moduleAttempt.moduleAttemptId,
        moduleNumber: moduleAttempt.moduleNumber,
        occurrenceId: currentOccurrence.occurrenceId,
        practice: currentPayload.practice,
        taskType: currentOccurrence.taskType
      };
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        const pending = pendingSaveRef.current;
        pendingSaveRef.current = null;
        if (pending) enqueuePendingSave(pending);
      }, 600);
      return next;
    });
  }, [currentOccurrence, currentPayload, enqueuePendingSave, runner]);

  useEffect(() => {
    const saveBeforeLeaving = () => {
      commitActiveQuestionTime();
      stageCurrentOccurrenceSave();
      const moduleAttempt = runnerRef.current
        ? readingFullSetActiveModuleAttempt(runnerRef.current.attempt)
        : null;
      if (moduleAttempt) cursorQueueRef.current?.flushBestEffort(moduleAttempt.moduleAttemptId);
    };
    window.addEventListener("pagehide", saveBeforeLeaving);
    return () => {
      window.removeEventListener("pagehide", saveBeforeLeaving);
    };
  }, [commitActiveQuestionTime, stageCurrentOccurrenceSave]);

  const move = useCallback((direction: -1 | 1) => {
    if (!runner || !currentPayload || movingRef.current) return;
    const nextPosition = moveReadingFullSetPosition(runner.occurrences, position, direction);
    const nextOccurrence = runner.occurrences[nextPosition.occurrenceIndex];
    const moduleAttempt = readingFullSetActiveModuleAttempt(runner.attempt);
    if (!nextOccurrence || !moduleAttempt) return;
    movingRef.current = true;
    setNavigating(true);
    const trace = createReadingFullSetPerformanceTrace(attemptId);
    const clickedAt = performance.now();
    const navigation: OccurrenceNavigation = {
      clickedAt,
      occurrenceId: nextOccurrence.occurrenceId,
      taskType: nextOccurrence.taskType,
      trace
    };
    transitionTraceRef.current = trace;
    logReadingFullSetPerformancePhase(trace, "navigation_click", {
      moduleNumber: moduleAttempt.moduleNumber,
      occurrenceId: nextOccurrence.occurrenceId,
      taskType: nextOccurrence.taskType
    });
    commitActiveQuestionTime();
    stageCurrentOccurrenceSave(trace);
    navigation.navigationAfterEnqueueAt = performance.now();
    logReadingFullSetPerformancePhase(trace, "navigation_after_enqueue", {
      durationMs: navigation.navigationAfterEnqueueAt - clickedAt,
      moduleNumber: moduleAttempt.moduleNumber,
      occurrenceId: currentOccurrence?.occurrenceId,
      taskType: currentOccurrence?.taskType
    });
    if (nextOccurrence.occurrenceId !== currentOccurrence?.occurrenceId) {
      activeTimingRef.current = null;
      navigationRef.current = navigation;
      setInteractiveOccurrenceId("");
      if (occurrencePayloads[nextOccurrence.occurrenceId]) {
        navigation.cacheStatus = "hit";
        const key = readingFullSetOccurrenceCacheKey({
          attemptId,
          moduleNumber: moduleAttempt.moduleNumber,
          occurrenceId: nextOccurrence.occurrenceId
        });
        logReadingFullSetPerformancePhase(trace, "navigation_cache_hit", {
          cacheStatus: "hit",
          imagePreloadStatus: imagePreloadStatusRef.current.get(key) ?? "not_applicable",
          moduleNumber: moduleAttempt.moduleNumber,
          occurrenceId: nextOccurrence.occurrenceId,
          taskType: nextOccurrence.taskType
        });
      }
    }
    setPosition(nextPosition);
    enqueueCursor(moduleAttempt, nextOccurrence.occurrenceId, nextPosition.questionIndex);
    if (nextOccurrence.occurrenceId === currentOccurrence?.occurrenceId) {
      requestAnimationFrame(() => {
        logReadingFullSetPerformancePhase(trace, "next_first_interactive", {
          cacheStatus: "hit",
          durationMs: performance.now() - clickedAt,
          moduleNumber: moduleAttempt.moduleNumber,
          occurrenceId: nextOccurrence.occurrenceId,
          taskType: nextOccurrence.taskType,
          totalDurationMs: performance.now() - clickedAt
        });
        if (transitionTraceRef.current?.traceId === trace.traceId) transitionTraceRef.current = null;
        movingRef.current = false;
        setNavigating(false);
      });
    }
  }, [attemptId, commitActiveQuestionTime, currentOccurrence, currentPayload, enqueueCursor, occurrencePayloads, position, runner, stageCurrentOccurrenceSave]);

  const leavePractice = useCallback(async () => {
    commitActiveQuestionTime();
    stageCurrentOccurrenceSave();
    const saved = await flushPendingSave();
    if (!saved) return;
    router.push(`${STUDENT_ROUTES.readingFullSets}/${encodeURIComponent(expectedFullSetId)}`);
  }, [commitActiveQuestionTime, expectedFullSetId, flushPendingSave, router, stageCurrentOccurrenceSave]);

  const submitModule = useCallback(async (automatic = false) => {
    const activeRunner = runnerRef.current;
    if (!activeRunner || submitting) return;
    const phase = readingFullSetAttemptPhase(activeRunner.attempt);
    const moduleNumber = phase === "module_1_active" ? 1 : phase === "module_2_active" ? 2 : null;
    if (!moduleNumber) return;
    if (!automatic && !window.confirm(`确定提交 Module ${moduleNumber} 吗？\n提交后不能返回修改答案。`)) return;
    if (!automatic && moduleNumber === 1) {
      const trace = beginTransitionTrace();
      logReadingFullSetPerformancePhase(trace, "m1_submit_click", { moduleNumber: 1 });
    }
    submittingRef.current = true;
    setSubmitting(true);
    clearOccurrenceCaches();
    setError("");
    try {
      commitActiveQuestionTime();
      stageCurrentOccurrenceSave(transitionTraceRef.current);
      const flushStartedAt = performance.now();
      if (moduleNumber === 1) {
        logTransitionPhase("m1_final_flush_start", { moduleNumber: 1 });
      }
      const saved = await flushPendingSave(
        readingFullSetRunnerModuleKey(activeRunner.attempt) ?? undefined,
        moduleNumber,
        transitionTraceRef.current
      );
      if (moduleNumber === 1) {
        logTransitionPhase("m1_final_flush_end", {
          durationMs: performance.now() - flushStartedAt,
          failure: saved ? null : "ANSWER_SAVE_FAILED",
          moduleNumber: 1,
          success: saved
        });
      }
      if (!saved) throw new Error("答案尚未成功保存，请稍后重试。");
      const submitStartedAt = performance.now();
      if (moduleNumber === 1) {
        logTransitionPhase("m1_submit_request_start", {
          moduleNumber: 1,
          route: `/api/reading/full-set-attempts/${attemptId}/modules/1/submit`
        });
      }
      const response = await fetch(
        `/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}/modules/${moduleNumber}/submit`,
        {
          method: "POST",
          cache: "no-store",
          headers: {
            ...readingFullSetTraceHeaders(accessToken, transitionTraceRef.current),
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ timeoutOnly: automatic })
        }
      );
      const result = await response.json().catch(() => ({})) as AttemptResponse;
      if (moduleNumber === 1) {
        logTransitionPhase("m1_submit_request_end", {
          durationMs: performance.now() - submitStartedAt,
          failure: response.ok ? null : "M1_SUBMIT_FAILED",
          moduleNumber: 1,
          route: `/api/reading/full-set-attempts/${attemptId}/modules/1/submit`,
          success: response.ok
        });
      }
      if (!response.ok || !result.attempt) throw new Error(result.error ?? "Module 提交失败，请稍后重试。");
      const submittedModuleAttemptId = readingFullSetRunnerModuleKey(activeRunner.attempt);
      if (submittedModuleAttemptId) saveQueueRef.current?.clear(submittedModuleAttemptId);
      const stillActive = readingFullSetActiveModuleAttempt(result.attempt);
      if (automatic && stillActive?.moduleNumber === moduleNumber) {
        applyAttempt(result.attempt);
        timeoutRetryAfterRef.current = Date.now() + 5_000;
        timeoutSubmitStartedRef.current = false;
        return;
      }
      const current = runnerRef.current;
      if (current) applyRunner({ ...current, attempt: result.attempt, occurrences: [] });
      if (result.attempt.status === "completed" && studentIdRef.current) {
        invalidateStudentWrongbook(studentIdRef.current);
      }
    } catch (submitError) {
      timeoutSubmitStartedRef.current = false;
      setError(submitError instanceof Error ? submitError.message : "Module 提交失败，请稍后重试。");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [accessToken, applyAttempt, applyRunner, attemptId, beginTransitionTrace, clearOccurrenceCaches, commitActiveQuestionTime, flushPendingSave, logTransitionPhase, stageCurrentOccurrenceSave, submitting]);

  useEffect(() => {
    if (!runner) return;
    const moduleAttempt = readingFullSetActiveModuleAttempt(runner.attempt);
    if (!moduleAttempt || !moduleAttempt.deadlineAt) return;
    const deadlineAt = moduleAttempt.deadlineAt;
    const update = () => {
      if (timerPausedForLoad) return;
      const remaining = readingFullSetRemainingSeconds({
        clientNowAtSyncMs: syncRef.current.clientNowAtSyncMs,
        clientNowMs: Date.now(),
        deadlineAt,
        serverNow: syncRef.current.serverNow
      });
      setRemainingSeconds(remaining);
      if (
        remaining === 0
        && !timeoutSubmitStartedRef.current
        && Date.now() >= timeoutRetryAfterRef.current
      ) {
        timeoutSubmitStartedRef.current = true;
        void submitModule(true);
      }
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [runner, submitModule, timerPausedForLoad]);

  const retryOccurrence = useCallback(async () => {
    if (!accessToken) return;
    const occurrenceId = currentOccurrence?.occurrenceId ?? null;
    setTimerPausedForLoad(true);
    let pause: { expiresAt: string; loadId: string } | null = null;
    try {
      pause = await beginLoadPause(accessToken, occurrenceId);
      clearOccurrenceCaches();
      runnerGenerationRef.current += 1;
      occurrenceRequestRef.current += 1;
      setOccurrencePayloads({});
      setAnswersByOccurrence({});
      answersRef.current = {};
      questionTimesRef.current = {};
      activeTimingRef.current = null;
      await loadRunner(accessToken);
      setOccurrenceLoad({ status: "idle" });
    } catch {
      if (pause) await finishLoadPause(accessToken, pause.loadId).catch(() => undefined);
      updateActiveLoadPause(null);
      setTimerPausedForLoad(false);
      setOccurrenceLoad({ message: "题目加载失败，请重试。", status: "error" });
    }
  }, [accessToken, beginLoadPause, clearOccurrenceCaches, currentOccurrence, finishLoadPause, loadRunner, updateActiveLoadPause]);

  const startModule2 = async () => {
    if (!accessToken || !runner || startingModule2) return;
    const trace = transitionTraceRef.current ?? beginTransitionTrace();
    logReadingFullSetPerformancePhase(trace, "m2_start_click", { moduleNumber: 2 });
    setStartingModule2(true);
    setError("");
    const route = `/api/reading/full-set-attempts/${attemptId}/modules/2/start`;
    const bootstrapStartedAt = performance.now();
    logTransitionPhase("m2_bootstrap_request_start", { moduleNumber: 2, route });
    try {
      const response = await fetchReadingFullSetWithTimeout(
        `/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}/modules/2/start`,
        {
          method: "POST",
          cache: "no-store",
          headers: readingFullSetTraceHeaders(accessToken, trace)
        },
        20_000
      );
      const result = await response.json().catch(() => ({})) as BootstrapResponse;
      logTransitionPhase("m2_bootstrap_response", {
        durationMs: performance.now() - bootstrapStartedAt,
        failure: response.ok ? null : result.code ?? "M2_PREPARE_FAILED",
        moduleNumber: 2,
        route,
        success: response.ok
      });
      if (!response.ok || !result.runner || !result.firstOccurrence) {
        throw new Error(result.error ?? "暂时无法开始 Module 2。");
      }
      if (result.runner.attempt.fullSetId !== expectedFullSetId) {
        throw new Error("这次练习不属于当前套题。");
      }
      const firstOccurrenceId = result.firstOccurrence.occurrence.occurrenceId;
      if (result.runner.occurrences[0]?.occurrenceId !== firstOccurrenceId) {
        throw new Error("Module 2 首题状态无效。");
      }
      applyRunner(result.runner);
      occurrenceCacheRef.current.prime(readingFullSetOccurrenceCacheKey({
        attemptId,
        moduleNumber: 2,
        occurrenceId: firstOccurrenceId
      }), result.firstOccurrence);
      revisionRef.current = Math.max(
        revisionRef.current,
        result.firstOccurrence.answerRevision
      );
      setOccurrencePayloads({ [firstOccurrenceId]: result.firstOccurrence });
      setAnswersByOccurrence({ [firstOccurrenceId]: result.firstOccurrence.answers });
      answersRef.current = { [firstOccurrenceId]: result.firstOccurrence.answers };
      questionTimesRef.current = { [firstOccurrenceId]: result.firstOccurrence.questionTimes };
      setOccurrenceLoad({ status: "idle" });
      setTimerPausedForLoad(false);
      logTransitionPhase("m2_state_applied", { moduleNumber: 2 }, true);
    } catch (startError) {
      setTimerPausedForLoad(false);
      const timedOut = startError instanceof Error && startError.name === "ReadingFullSetRequestTimeout";
      const networkAbort = startError instanceof DOMException && startError.name === "AbortError";
      if (timedOut || networkAbort) {
        logTransitionPhase("m2_bootstrap_response", {
          durationMs: performance.now() - bootstrapStartedAt,
          failure: timedOut ? "BOOTSTRAP_TIMEOUT" : "NETWORK_ABORT",
          moduleNumber: 2,
          route,
          success: false
        });
      }
      setError(timedOut
        ? "Module 2 准备超时，请重试。"
        : startError instanceof Error ? startError.message : "暂时无法开始 Module 2。");
    } finally {
      setStartingModule2(false);
    }
  };

  if (loading) return <RunnerMessage title="正在准备套题练习" description="正在加载练习内容..." />;
  if (!runner) {
    return (
      <RunnerMessage
        actionLabel="重试"
        description={error || "套题练习加载失败，请稍后重试。"}
        onAction={() => window.location.reload()}
        title="无法进入套题练习"
      />
    );
  }
  const phase = readingFullSetAttemptPhase(runner.attempt);
  if (phase === "module_2_ready") {
    return (
      <RunnerMessage
        actionLabel={startingModule2 ? "正在开始..." : "开始 Module 2"}
        description="接下来是 Module 2 · 15题 · 9:00。点击开始后才会启动独立倒计时。"
        disabled={startingModule2}
        error={error}
        onAction={() => void startModule2()}
        title="Module 1 已完成"
      />
    );
  }
  if (phase === "completed") {
    return (
      <RunnerMessage
        actionHref={`${STUDENT_ROUTES.readingFullSets}/${encodeURIComponent(expectedFullSetId)}/result/${encodeURIComponent(attemptId)}`}
        actionLabel="查看结果"
        description="两个 Module 均已提交。"
        title="练习已完成"
      />
    );
  }

  const moduleNumber = phase === "module_1_preparing" || phase === "module_1_active" ? 1 : 2;
  const moduleQuestionCount = moduleNumber === 1 ? 35 : 15;
  const currentModuleAttempt = readingFullSetCurrentModuleAttempt(runner.attempt);
  const workspaceInteractive = currentModuleAttempt?.status === "active"
    && occurrenceLoad.status === "idle";
  const currentAnswers = currentOccurrence ? answersByOccurrence[currentOccurrence.occurrenceId] ?? {} : {};
  const displayRange = currentOccurrence
    ? readingFullSetDisplayRange(currentOccurrence, position.questionIndex)
    : { start: 1, end: 1 };
  const isFirst = position.occurrenceIndex === 0 && position.questionIndex === 0;
  const lastOccurrenceIndex = runner.occurrences.length - 1;
  const lastOccurrence = runner.occurrences[lastOccurrenceIndex];
  const isLast = position.occurrenceIndex === lastOccurrenceIndex
    && Boolean(lastOccurrence)
    && displayRange.end === lastOccurrence.sourceQuestionEnd;
  const progressLabel = `Module ${moduleNumber} · ${displayRange.start === displayRange.end
    ? `Question ${displayRange.start} / ${moduleQuestionCount}`
    : `Questions ${displayRange.start}–${displayRange.end} / ${moduleQuestionCount}`}`;

  return (
    <div className="h-[100dvh] overflow-hidden bg-[#fbfbfe] text-student-text">
      <ReadingPracticeHeader
        elapsedSeconds={0}
        onBack={() => void leavePractice()}
        progressLabel={progressLabel}
        progressTestId="full-set-question-number"
        timeLabel="Time Left"
        timeTestId="full-set-time-left"
        timeValue={formatReadingFullSetTime(remainingSeconds)}
        title={runner.title}
      />
      <main
        className="mx-auto h-[calc(100dvh-68px)] min-h-0"
        style={readingTwoColumnScaleStyle}
      >
        <ReadingQuestionViewport
          canGoNext={!isLast}
          canGoPrevious={!isFirst}
          module={currentOccurrence?.taskType ?? "rap"}
          navigationDisabled={!currentPayload || !workspaceInteractive || navigating || submitting}
          onNext={() => void move(1)}
          onPrevious={() => void move(-1)}
          onSubmit={() => void submitModule(false)}
          readOnly={false}
          submitError={saveError || error}
          submitDisabled={!currentPayload || !workspaceInteractive || navigating}
          submitLabel={`Submit Module ${moduleNumber}`}
          submitting={submitting}
        >
          {occurrenceLoad.status === "error" ? (
            <div className="m-auto grid justify-items-center gap-3 text-center">
              <p className="text-sm font-semibold text-student-error">{occurrenceLoad.message}</p>
              <button
                className="student-button-secondary min-h-10 px-4"
                onClick={() => void retryOccurrence()}
                type="button"
              >
                重试
              </button>
            </div>
          ) : currentPayload && currentQuestion ? (
            <ReadingWorkspaceRouter
              answers={currentAnswers}
              currentQuestion={currentQuestion}
              lookupEnabled={readingLookupEnabled("active", currentPayload.practice.item.module)}
              onAnswerChange={updateAnswer}
              onReady={handleWorkspaceReady}
              practice={currentPayload.practice}
              readOnly={!workspaceInteractive}
            />
          ) : (
            <p className="m-auto text-sm text-student-muted">正在加载当前题目...</p>
          )}
        </ReadingQuestionViewport>
      </main>
    </div>
  );
}

function RunnerMessage({
  actionHref,
  actionLabel,
  description,
  disabled = false,
  error,
  onAction,
  title
}: {
  actionHref?: string;
  actionLabel?: string;
  description: string;
  disabled?: boolean;
  error?: string;
  onAction?: () => void;
  title: string;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#fbfbfe] px-5">
      <section className="student-card w-full max-w-lg p-8 text-center">
        <h1 className="text-2xl font-bold text-student-text">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-student-muted">{description}</p>
        {error ? <p className="mt-3 text-sm font-semibold text-student-error">{error}</p> : null}
        {actionHref && actionLabel ? (
          <Link className="student-button-primary mt-6" href={actionHref}>{actionLabel}</Link>
        ) : onAction && actionLabel ? (
          <button className="student-button-primary mt-6" disabled={disabled} onClick={onAction} type="button">{actionLabel}</button>
        ) : null}
      </section>
    </main>
  );
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}
