"use client";

import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight, Clock3 } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
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
  readingFullSetAttemptPhase,
  readingFullSetDisplayRange,
  readingFullSetRemainingSeconds,
  type ReadingFullSetAttemptSummary,
  type ReadingFullSetOccurrencePracticePayload,
  type ReadingFullSetRunnerPayload,
  type ReadingFullSetRunnerPosition
} from "@/lib/reading/fullSetAttempts";
import {
  setReadingAnswer,
  type ReadingAnswer,
  type ReadingAnswerState
} from "@/lib/reading/practiceState";
import { readingLookupEnabled } from "@/lib/reading/lookupCapabilities";
import { formatReadingFullSetTime } from "@/lib/reading/fullSetPresentation";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import {
  ReadingWorkspaceRouter,
  readingTwoColumnScaleStyle
} from "./ReadingPractice";

type RunnerResponse = { error?: string; runner?: ReadingFullSetRunnerPayload };
type OccurrenceResponse = Partial<ReadingFullSetOccurrencePracticePayload> & { error?: string };
type AttemptResponse = { attempt?: ReadingFullSetAttemptSummary; error?: string };
type SaveResponse = {
  accepted?: boolean;
  answerRevision?: number;
  attempt?: ReadingFullSetAttemptSummary;
  error?: string;
  reason?: "locked" | "stale_revision" | "timed_out";
};

type PendingSave = {
  answers: ReadingAnswerState;
  occurrenceId: string;
  practice: ReadingFullSetOccurrencePracticePayload["practice"];
};

export function ReadingFullSetRunner({
  attemptId,
  expectedFullSetId
}: {
  attemptId: string;
  expectedFullSetId: string;
}) {
  const router = useRouter();
  const { invalidate, setData: setCachedData } = useStudentDataCache();
  const [accessToken, setAccessToken] = useState("");
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [startingModule2, setStartingModule2] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<PendingSave | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const saveFailedRef = useRef(false);
  const timeoutSubmitStartedRef = useRef(false);

  const applyRunner = useCallback((next: ReadingFullSetRunnerPayload) => {
    runnerRef.current = next;
    setRunner(next);
    setCachedData(`reading:full-sets:attempt:${next.attempt.fullSetId}`, {
      attempt: next.attempt
    });
    if (next.attempt.status === "completed") {
      invalidate(`${STUDENT_READING_FULL_SET_CACHE_PREFIX}:catalog`);
      invalidate(STUDENT_PRACTICE_HISTORY_CACHE_PREFIX);
    }
    const phase = readingFullSetAttemptPhase(next.attempt);
    const moduleAttempt = phase === "module_1_active"
      ? next.attempt.module1
      : phase === "module_2_active"
        ? next.attempt.module2
        : null;
    if (moduleAttempt) {
      revisionRef.current = moduleAttempt.answerRevision;
      syncRef.current = {
        clientNowAtSyncMs: Date.now(),
        serverNow: next.attempt.serverNow
      };
      setRemainingSeconds(readingFullSetRemainingSeconds({
        clientNowAtSyncMs: syncRef.current.clientNowAtSyncMs,
        clientNowMs: Date.now(),
        deadlineAt: moduleAttempt.deadlineAt,
        serverNow: next.attempt.serverNow
      }));
      timeoutSubmitStartedRef.current = false;
    }
  }, [invalidate, setCachedData]);

  const loadRunner = useCallback(async (token: string) => {
    const response = await fetch(`/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` }
    });
    const payload = await response.json().catch(() => ({})) as RunnerResponse;
    if (!response.ok || !payload.runner) {
      throw new Error(payload.error ?? "套题练习加载失败，请稍后重试。");
    }
    if (payload.runner.attempt.fullSetId !== expectedFullSetId) {
      throw new Error("这次练习不属于当前套题。");
    }
    applyRunner(payload.runner);
    setPosition({ occurrenceIndex: 0, questionIndex: 0 });
  }, [applyRunner, attemptId, expectedFullSetId]);

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
    let cancelled = false;
    void createBrowserSupabase().auth.getSession().then(async ({ data }) => {
      try {
        if (!data.session) throw new Error("请先登录后再开始套题练习。");
        if (cancelled) return;
        setAccessToken(data.session.access_token);
        await loadRunner(data.session.access_token);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "套题练习加载失败，请稍后重试。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [loadRunner]);

  const currentOccurrence = runner?.occurrences[position.occurrenceIndex] ?? null;
  const currentPayload = currentOccurrence
    ? occurrencePayloads[currentOccurrence.occurrenceId] ?? null
    : null;
  const currentQuestion = currentPayload?.practice.questions[position.questionIndex];

  useEffect(() => {
    if (!accessToken || !currentOccurrence || currentPayload) return;
    let cancelled = false;
    void fetch(
      `/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}/occurrences/${encodeURIComponent(currentOccurrence.occurrenceId)}`,
      { cache: "no-store", headers: { Authorization: `Bearer ${accessToken}` } }
    ).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as OccurrenceResponse;
      if (!response.ok || !payload.practice || !payload.occurrence || !payload.answers || !Number.isInteger(payload.answerRevision)) {
        throw new Error(payload.error ?? "套题题目加载失败，请稍后重试。");
      }
      if (cancelled) return;
      const completePayload = payload as ReadingFullSetOccurrencePracticePayload;
      revisionRef.current = Math.max(revisionRef.current, completePayload.answerRevision);
      setOccurrencePayloads((current) => ({
        ...current,
        [currentOccurrence.occurrenceId]: completePayload
      }));
      setAnswersByOccurrence((current) => {
        if (current[currentOccurrence.occurrenceId]) return current;
        const next = { ...current, [currentOccurrence.occurrenceId]: completePayload.answers };
        answersRef.current = next;
        return next;
      });
      questionTimesRef.current = {
        ...questionTimesRef.current,
        [currentOccurrence.occurrenceId]: completePayload.questionTimes
      };
    }).catch((loadError) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : "套题题目加载失败，请稍后重试。");
    });
    return () => { cancelled = true; };
  }, [accessToken, attemptId, currentOccurrence, currentPayload]);

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
    if (!currentOccurrence || !currentQuestion) return;
    const active = activeTimingRef.current;
    if (active?.occurrenceId === currentOccurrence.occurrenceId && active.questionId === currentQuestion.questionId) return;
    commitActiveQuestionTime();
    activeTimingRef.current = {
      occurrenceId: currentOccurrence.occurrenceId,
      questionId: currentQuestion.questionId,
      startedAt: Date.now()
    };
  }, [commitActiveQuestionTime, currentOccurrence, currentQuestion]);

  const persistSave = useCallback((pending: PendingSave) => {
    saveChainRef.current = saveChainRef.current.then(async () => {
      const activeRunner = runnerRef.current;
      if (!accessToken || !activeRunner) return;
      const phase = readingFullSetAttemptPhase(activeRunner.attempt);
      const moduleNumber = phase === "module_1_active" ? 1 : phase === "module_2_active" ? 2 : null;
      if (!moduleNumber) return;
      setSaving(true);
      saveFailedRef.current = false;
      try {
        const answers: ReadingSubmittedAnswer[] = buildReadingSubmissionAnswers(
          pending.practice,
          pending.answers,
          snapshotQuestionTimes(pending.occurrenceId)
        );
        const response = await fetch(
          `/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}/occurrences/${encodeURIComponent(pending.occurrenceId)}`,
          {
            method: "PUT",
            cache: "no-store",
            keepalive: true,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              answers,
              expectedRevision: revisionRef.current,
              moduleNumber
            })
          }
        );
        const result = await response.json().catch(() => ({})) as SaveResponse;
        if (!response.ok || !result.accepted || !Number.isInteger(result.answerRevision)) {
          if (result.attempt) {
            const current = runnerRef.current;
            if (current) applyRunner({ ...current, attempt: result.attempt, occurrences: [] });
          }
          throw new Error(
            result.reason === "timed_out" || result.reason === "locked"
              ? "当前 Module 已结束，答案不能再修改。"
              : result.reason === "stale_revision"
                ? "答案状态已在其他页面更新，请刷新后继续。"
                : result.error ?? "答案保存失败，请稍后重试。"
          );
        }
        revisionRef.current = Number(result.answerRevision);
      } catch (saveError) {
        saveFailedRef.current = true;
        setError(saveError instanceof Error ? saveError.message : "答案保存失败，请稍后重试。");
      } finally {
        setSaving(false);
      }
    });
    return saveChainRef.current;
  }, [accessToken, applyRunner, attemptId, snapshotQuestionTimes]);

  const flushPendingSave = useCallback(async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pending) await persistSave(pending);
    await saveChainRef.current;
    return !saveFailedRef.current;
  }, [persistSave]);

  const stageCurrentOccurrenceSave = useCallback(() => {
    if (!currentOccurrence || !currentPayload) return;
    pendingSaveRef.current = {
      answers: answersRef.current[currentOccurrence.occurrenceId] ?? {},
      occurrenceId: currentOccurrence.occurrenceId,
      practice: currentPayload.practice
    };
  }, [currentOccurrence, currentPayload]);

  useEffect(() => {
    if (!currentOccurrence || !currentPayload) return;
    const timer = window.setInterval(() => {
      commitActiveQuestionTime();
      stageCurrentOccurrenceSave();
      void flushPendingSave();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [commitActiveQuestionTime, currentOccurrence, currentPayload, flushPendingSave, stageCurrentOccurrenceSave]);

  const updateAnswer = useCallback((questionId: string, answer: ReadingAnswer) => {
    if (!currentOccurrence || !currentPayload) return;
    setAnswersByOccurrence((current) => {
      const occurrenceAnswers = current[currentOccurrence.occurrenceId] ?? {};
      const nextOccurrenceAnswers = setReadingAnswer(occurrenceAnswers, questionId, answer);
      const next = { ...current, [currentOccurrence.occurrenceId]: nextOccurrenceAnswers };
      answersRef.current = next;
      pendingSaveRef.current = {
        answers: nextOccurrenceAnswers,
        occurrenceId: currentOccurrence.occurrenceId,
        practice: currentPayload.practice
      };
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        const pending = pendingSaveRef.current;
        pendingSaveRef.current = null;
        if (pending) void persistSave(pending);
      }, 600);
      return next;
    });
  }, [currentOccurrence, currentPayload, persistSave]);

  useEffect(() => {
    const saveBeforeLeaving = () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      const pending = pendingSaveRef.current;
      pendingSaveRef.current = null;
      if (pending) void persistSave(pending);
    };
    window.addEventListener("pagehide", saveBeforeLeaving);
    return () => {
      window.removeEventListener("pagehide", saveBeforeLeaving);
      saveBeforeLeaving();
    };
  }, [persistSave]);

  const move = useCallback(async (direction: -1 | 1) => {
    if (!runner || !currentPayload) return;
    commitActiveQuestionTime();
    stageCurrentOccurrenceSave();
    const saved = await flushPendingSave();
    if (!saved) return;
    setPosition((current) => moveReadingFullSetPosition(runner.occurrences, current, direction));
  }, [commitActiveQuestionTime, currentPayload, flushPendingSave, runner, stageCurrentOccurrenceSave]);

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
    setSubmitting(true);
    setError("");
    try {
      commitActiveQuestionTime();
      stageCurrentOccurrenceSave();
      if (automatic) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        pendingSaveRef.current = null;
      } else {
        const saved = await flushPendingSave();
        if (!saved) throw new Error("答案尚未成功保存，请稍后重试。");
      }
      const response = await fetch(
        `/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}/modules/${moduleNumber}/submit`,
        {
          method: "POST",
          cache: "no-store",
          headers: { Authorization: `Bearer ${accessToken}` }
        }
      );
      const result = await response.json().catch(() => ({})) as AttemptResponse;
      if (!response.ok || !result.attempt) throw new Error(result.error ?? "Module 提交失败，请稍后重试。");
      const current = runnerRef.current;
      if (current) applyRunner({ ...current, attempt: result.attempt, occurrences: [] });
    } catch (submitError) {
      timeoutSubmitStartedRef.current = false;
      setError(submitError instanceof Error ? submitError.message : "Module 提交失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }, [accessToken, applyRunner, attemptId, commitActiveQuestionTime, flushPendingSave, stageCurrentOccurrenceSave, submitting]);

  useEffect(() => {
    if (!runner) return;
    const phase = readingFullSetAttemptPhase(runner.attempt);
    const moduleAttempt = phase === "module_1_active"
      ? runner.attempt.module1
      : phase === "module_2_active"
        ? runner.attempt.module2
        : null;
    if (!moduleAttempt) return;
    const update = () => {
      const remaining = readingFullSetRemainingSeconds({
        clientNowAtSyncMs: syncRef.current.clientNowAtSyncMs,
        clientNowMs: Date.now(),
        deadlineAt: moduleAttempt.deadlineAt,
        serverNow: syncRef.current.serverNow
      });
      setRemainingSeconds(remaining);
      if (remaining === 0 && !timeoutSubmitStartedRef.current) {
        timeoutSubmitStartedRef.current = true;
        void submitModule(true);
      }
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [runner, submitModule]);

  const startModule2 = async () => {
    if (!accessToken || !runner || startingModule2) return;
    setStartingModule2(true);
    setError("");
    try {
      const response = await fetch(
        `/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}/modules/2/start`,
        { method: "POST", cache: "no-store", headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const result = await response.json().catch(() => ({})) as AttemptResponse;
      if (!response.ok || !result.attempt) throw new Error(result.error ?? "暂时无法开始 Module 2。");
      setOccurrencePayloads({});
      setAnswersByOccurrence({});
      answersRef.current = {};
      questionTimesRef.current = {};
      activeTimingRef.current = null;
      await loadRunner(accessToken);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "暂时无法开始 Module 2。");
    } finally {
      setStartingModule2(false);
    }
  };

  if (loading) return <RunnerMessage title="正在准备套题练习" description="正在加载练习内容..." />;
  if (!runner) return <RunnerMessage title="无法进入套题练习" description={error || "套题练习加载失败，请稍后重试。"} />;
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

  const moduleNumber = phase === "module_1_active" ? 1 : 2;
  const moduleQuestionCount = moduleNumber === 1 ? 35 : 15;
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

  return (
    <div className="h-[100dvh] overflow-hidden bg-[#fbfbfe] text-student-text">
      <header className="grid h-[76px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 border-b border-student-border bg-white px-4 sm:px-7 lg:px-10">
        <button
          className="writing-header-back justify-self-start"
          onClick={() => void leavePractice()}
          type="button"
        >
          <ArrowLeft aria-hidden="true" size={20} strokeWidth={2.2} />
          <span>Back</span>
        </button>
        <div className="min-w-0 text-center">
          <p className="truncate text-sm font-bold text-student-primary">{runner.title}</p>
          <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-student-muted">Module {moduleNumber}</p>
        </div>
        <div className="flex min-h-[54px] items-center gap-2 justify-self-end rounded-xl border border-student-primary-border bg-student-primary-soft px-3 text-student-primary sm:px-4">
          <Clock3 aria-hidden="true" size={19} />
          <div className="text-center">
            <p className="text-[9px] font-semibold uppercase tracking-[0.08em]">Time Left</p>
            <p className="font-mono text-base font-bold leading-5 tabular-nums text-student-text" data-testid="full-set-time-left">
              {formatReadingFullSetTime(remainingSeconds)}
            </p>
          </div>
        </div>
      </header>
      <main
        className="mx-auto flex h-[calc(100dvh-76px)] min-h-0 max-w-[1440px] flex-col px-4 py-4 sm:px-6 lg:px-8"
        style={currentOccurrence?.taskType === "ctw" ? undefined : readingTwoColumnScaleStyle}
      >
        <section className={currentOccurrence?.taskType === "ctw"
          ? "min-h-0 flex-1 overflow-auto rounded-2xl border border-student-border bg-white p-5 shadow-sm sm:p-7"
          : "flex min-h-0 flex-1 flex-col overflow-hidden bg-white"}
        >
          {currentPayload && currentQuestion ? (
            <ReadingWorkspaceRouter
              answers={currentAnswers}
              currentQuestion={currentQuestion}
              lookupEnabled={readingLookupEnabled("active", currentPayload.practice.item.module)}
              onAnswerChange={updateAnswer}
              practice={currentPayload.practice}
              readOnly={false}
            />
          ) : (
            <p className="m-auto text-sm text-student-muted">正在加载当前题目...</p>
          )}
        </section>
        <nav className="mt-4 grid min-h-16 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 rounded-2xl border border-student-border bg-white px-4 py-2 shadow-sm" aria-label="套题题目导航">
          <button className="student-button-secondary h-10 w-28 justify-self-start" disabled={isFirst || !currentPayload || saving || submitting} onClick={() => void move(-1)} type="button">
            <ChevronLeft aria-hidden="true" size={18} /> Previous
          </button>
          <p className="text-center text-sm font-bold text-student-text" data-testid="full-set-question-number">
            {displayRange.start === displayRange.end
              ? `Question ${displayRange.start} / ${moduleQuestionCount}`
              : `Questions ${displayRange.start}–${displayRange.end} / ${moduleQuestionCount}`}
          </p>
          {isLast ? (
            <button className="student-button-primary h-10 min-w-28 justify-self-end" disabled={!currentPayload || saving || submitting} onClick={() => void submitModule(false)} type="button">
              {submitting ? "Submitting..." : `Submit Module ${moduleNumber}`}
            </button>
          ) : (
            <button className="student-button-secondary h-10 w-28 justify-self-end" disabled={!currentPayload || saving || submitting} onClick={() => void move(1)} type="button">
              Next <ChevronRight aria-hidden="true" size={18} />
            </button>
          )}
        </nav>
        {saving ? <p className="mt-1 text-right text-xs text-student-muted">正在保存答案...</p> : null}
        {error ? <p className="mt-1 text-sm font-semibold text-student-error">{error}</p> : null}
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
