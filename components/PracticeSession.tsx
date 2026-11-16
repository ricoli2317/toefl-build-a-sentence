"use client";
import { LexicalLookupProvider } from "@/components/lexical/LexicalLookup";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  joinTextItems,
  splitTextItems
} from "@/lib/questionText";
import {
  QuestionDisplay,
  type QuestionWordBlock
} from "@/components/shared/QuestionDisplay";
import { PracticeReview } from "@/components/shared/PracticeReview";
import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  STUDENT_LOGICAL_CATALOG_CACHE_PREFIX,
  STUDENT_WRONG_QUESTIONS_CACHE_PREFIX,
  STUDENT_PRACTICE_HISTORY_CACHE_PREFIX,
  studentAttemptCacheKey,
  studentQuestionsCacheKey,
  useStudentCachedData,
  useStudentDataCache,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { STUDENT_PRACTICE_ENTITLEMENTS_CACHE_KEY } from "@/lib/practiceEntitlements";
import { isVirtualPracticeSetId, withStudentReturnTo } from "@/lib/studentNavigation";
import { broadcastStudentPracticeCompleted } from "@/lib/studentCacheEvents";
import {
  logStudentPerformance,
  measureStudentRequest
} from "@/lib/studentPerformance.client";
import type { PublicQuestion, SubmitResponse } from "@/lib/types";

type SavedAnswer = {
  chunks: string[];
  questionTimeSeconds: number;
};

type SavedAnswers = Record<string, SavedAnswer>;

type OptionChunk = QuestionWordBlock;

type DraftAnswers = Record<string, Array<OptionChunk | null>>;

type QuestionTimes = Record<string, number>;

type QuestionsPayload = {
  error?: string;
  questions?: PublicQuestion[];
};

const DEFAULT_TIME_SECONDS = 6 * 60 + 50;

export type PracticeProgressSnapshot = {
  answers: Record<string, string[]>;
  questionTimes: Record<string, number>;
  currentIndex: number;
  elapsedSeconds: number;
  paused?: boolean;
};

export type PracticeSessionInitialDraft = Partial<PracticeProgressSnapshot>;

export function PracticeSession({
  allowEndPractice = false,
  allowPause = false,
  assignmentId = null,
  grammarSessionId = null,
  hideQuestionCardNumber = false,
  initialDraft,
  initialElapsedSeconds = 0,
  initialPaused = false,
  initialQuestions,
  onProgress,
  requiresPracticeStart = false,
  returnTo,
  setId,
  setTitle,
  stopwatch = false,
  submitAnsweredOnly = false,
  timed = true,
  totalSeconds = DEFAULT_TIME_SECONDS
}: {
  allowEndPractice?: boolean;
  /** Positive timer may be paused explicitly; only used with stopwatch. */
  allowPause?: boolean;
  /** Teacher Assignment origin; validated again by the start RPC. */
  assignmentId?: string | null;
  /** Persisted BAS Grammar random session. Never trusted without server validation. */
  grammarSessionId?: string | null;
  hideQuestionCardNumber?: boolean;
  /** Restored answer/progress snapshot for a persisted session. */
  initialDraft?: PracticeSessionInitialDraft;
  /** Elapsed seconds already saved when resuming. */
  initialElapsedSeconds?: number;
  /** Persisted positive-timer pause state when resuming. */
  initialPaused?: boolean;
  initialQuestions?: PublicQuestion[];
  /** Optional debounced progress save for a persisted session. */
  onProgress?: (snapshot: PracticeProgressSnapshot) => void;
  /** Ordinary BAS entry must call the explicit Start/Unlock endpoint. */
  requiresPracticeStart?: boolean;
  /** Assignment-origin safe return path forwarded to the result page. */
  returnTo?: string | null;
  setId: string;
  setTitle?: string;
  /** Positive elapsed-time display for untimed wrong-question practice. */
  stopwatch?: boolean;
  submitAnsweredOnly?: boolean;
  timed?: boolean;
  totalSeconds?: number;
}) {
  const router = useRouter();
  const { invalidate, recordOfficialAttempt, setData } = useStudentDataCache();
  const usesProvidedQuestions = Boolean(initialQuestions);
  const questionState = useStudentCachedData<QuestionsPayload>(
    studentQuestionsCacheKey(setId),
    (session) => loadPracticeQuestions(setId, session),
    { enabled: !usesProvidedQuestions }
  );
  const cachedQuestions = questionState.data?.questions;
  const questions = useMemo(
    () => initialQuestions ?? cachedQuestions ?? [],
    [cachedQuestions, initialQuestions]
  );
  const questionLoading = usesProvidedQuestions ? false : questionState.loading;
  const restored = useMemo(
    () => hydratePracticeDraft(questions, initialDraft),
    [initialDraft, questions]
  );
  const safeInitialElapsedSeconds = Math.max(
    0,
    Math.round(initialElapsedSeconds || 0)
  );
  const initialTimedElapsedSeconds = timed
    ? Math.min(totalSeconds, safeInitialElapsedSeconds)
    : safeInitialElapsedSeconds;
  const [currentIndex, setCurrentIndex] = useState(restored.currentIndex);
  const [currentAnswer, setCurrentAnswer] = useState<Array<OptionChunk | null>>([]);
  const [draftAnswers, setDraftAnswers] = useState<DraftAnswers>(restored.answers);
  const [questionTimes, setQuestionTimes] = useState<QuestionTimes>(restored.questionTimes);
  const [showReview, setShowReview] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<SubmitResponse | null>(null);
  const [startedAt] = useState(() => Date.now() - initialTimedElapsedSeconds * 1000);
  const [questionStartedAt, setQuestionStartedAt] = useState(() => Date.now());
  const [remainingSeconds, setRemainingSeconds] = useState(
    Math.max(0, totalSeconds - initialTimedElapsedSeconds)
  );
  const [elapsedDisplaySeconds, setElapsedDisplaySeconds] = useState(
    () => stopwatch ? safeInitialElapsedSeconds : 0
  );
  const [timerPaused, setTimerPaused] = useState(
    () => Boolean(allowPause && stopwatch && initialPaused)
  );
  const elapsedBaseRef = useRef(safeInitialElapsedSeconds);
  const elapsedRunStartedRef = useRef<number | null>(null);
  const latestProgressRef = useRef<PracticeProgressSnapshot | null>(null);
  const elapsedDisplayRef = useRef(elapsedDisplaySeconds);
  elapsedDisplayRef.current = elapsedDisplaySeconds;
  const [visitedQuestionIds, setVisitedQuestionIds] = useState<Set<string>>(
    () => new Set(Object.keys(restored.answers))
  );
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const [startStatus, setStartStatus] = useState<"loading" | "ready" | "error">(
    requiresPracticeStart ? "loading" : "ready"
  );
  const [startError, setStartError] = useState("");

  useEffect(() => {
    if (!requiresPracticeStart || isVirtualPracticeSetId(setId.trim())) {
      setStartStatus("ready");
      return;
    }
    let cancelled = false;
    async function startPractice() {
      setStartStatus("loading");
      setStartError("");
      try {
        const supabase = createBrowserSupabase();
        const {
          data: { session }
        } = await supabase.auth.getSession();
        const response = await fetch(
          `/api/sets/${encodeURIComponent(setId)}/start`,
          {
            method: "POST",
            cache: "no-store",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session?.access_token ?? ""}`
            },
            body: JSON.stringify({ assignmentId: assignmentId || null })
          }
        );
        const payload = (await response.json().catch(() => ({}))) as {
          access?: { allowed?: boolean };
          error?: string;
        };
        if (!response.ok || payload.access?.allowed !== true) {
          throw new Error(payload.error ?? "暂时无法开始这道练习，请稍后重试。");
        }
        invalidate(STUDENT_PRACTICE_ENTITLEMENTS_CACHE_KEY);
        invalidate(STUDENT_LOGICAL_CATALOG_CACHE_PREFIX);
        if (!cancelled) setStartStatus("ready");
      } catch (error) {
        invalidate(STUDENT_PRACTICE_ENTITLEMENTS_CACHE_KEY);
        invalidate(STUDENT_LOGICAL_CATALOG_CACHE_PREFIX);
        if (!cancelled) {
          setStartError(
            error instanceof Error
              ? error.message
              : "暂时无法开始这道练习，请稍后重试。"
          );
          setStartStatus("error");
        }
      }
    }
    void startPractice();
    return () => {
      cancelled = true;
    };
  }, [assignmentId, invalidate, requiresPracticeStart, setId]);

  const startLoading = requiresPracticeStart && startStatus === "loading";
  const loading = questionLoading || startLoading;
  const currentQuestion = questions[currentIndex];
  const currentQuestionId = currentQuestion?.question_id;
  const currentBlankCount = currentQuestion?.blank_count ?? 0;
  const displayError = error || questionState.error;

  const submitAll = useCallback(
    async (
      answersToSubmit: SavedAnswers,
      forcedTimeSpentSeconds?: number,
      questionIdsToSubmit?: string[]
    ) => {
      const submitStartedAt = performance.now();
      setSubmitting(true);
      setError("");

      try {
        const effectiveQuestionIds =
          questionIdsToSubmit ?? (usesProvidedQuestions ? questions.map((question) => question.question_id) : undefined);
        const supabase = createBrowserSupabase();
        const {
          data: { session }
        } = await supabase.auth.getSession();

        const response = await measureStudentRequest(
          "POST /api/submissions",
          async (captureResponse) => {
            const submitResponse = await fetch("/api/submissions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${session?.access_token ?? ""}`
              },
              body: JSON.stringify({
                setId,
                setTitle,
                grammarSessionId: grammarSessionId ?? undefined,
                questionIds: effectiveQuestionIds,
                answers: questions
                  .filter((question) =>
                    effectiveQuestionIds ? effectiveQuestionIds.includes(question.question_id) : true
                  )
                  .map((question) => ({
                    questionId: question.question_id,
                    submittedOrderText: joinTextItems(
                      answersToSubmit[question.question_id]?.chunks ?? []
                    ),
                    question_time_seconds:
                      answersToSubmit[question.question_id]?.questionTimeSeconds ?? 0
                  })),
                timeSpentSeconds:
                  forcedTimeSpentSeconds ??
                  (stopwatch && !timed
                    ? Math.max(0, Math.round(elapsedDisplayRef.current))
                    : Math.min(
                        timed ? totalSeconds : Number.MAX_SAFE_INTEGER,
                        Math.max(0, Math.round((Date.now() - startedAt) / 1000))
                      ))
              })
            });
            captureResponse(submitResponse);
            return submitResponse;
          }
        );

        const responseText = await response.text();
        let payload: { attemptId?: string; error?: string } & Partial<SubmitResponse>;
        try {
          payload = responseText
            ? JSON.parse(responseText)
            : { error: "The submit API returned an empty response." };
        } catch {
          payload = { error: "The submit API returned invalid JSON." };
        }

        if (!response.ok) {
          setError(payload.error ?? "Submit failed.");
        } else if (isSubmitResponse(payload)) {
          setResult(payload);
          if (payload.attempt && payload.answers) {
            setData(studentAttemptCacheKey(payload.attemptId), {
              attempt: payload.attempt,
              total_count: payload.total_count ?? payload.total,
              correct_count: payload.correct_count ?? payload.correctCount,
              accuracy: payload.accuracy,
              peer_comparison: payload.peer_comparison,
              answers: payload.answers
            });
          }
          invalidate(STUDENT_WRONG_QUESTIONS_CACHE_PREFIX);
          invalidate(STUDENT_PRACTICE_HISTORY_CACHE_PREFIX);
          const isVirtualPractice = isVirtualPracticeSetId(setId.trim());
          const officialAttempt = isVirtualPractice
            ? undefined
            : {
                attempt_id: payload.attemptId,
                set_id: setId,
                submitted_at:
                  payload.attempt?.submitted_at ?? new Date().toISOString(),
                correct_count: payload.correct_count ?? payload.correctCount,
                total_questions: payload.total_count ?? payload.total,
                accuracy: payload.accuracy
              };

          if (!isVirtualPractice) {
            recordOfficialAttempt(officialAttempt!);
          }
          if (session?.user.id) {
            broadcastStudentPracticeCompleted({
              studentId: session.user.id,
              isWrongQuestionsPractice: isVirtualPractice,
              attempt: officialAttempt
            });
          }
          logStudentPerformance({
            event: "bas_core_submission_ready",
            totalMs: Math.round((performance.now() - submitStartedAt) * 10) / 10
          });
          router.push(withStudentReturnTo(`/student/results/${payload.attemptId}`, returnTo));
        } else {
          setError("Submit succeeded but no attempt id was returned.");
        }
      } catch {
        setError("Submit failed before the server returned a response.");
      } finally {
        setSubmitting(false);
      }
    },
    [
      grammarSessionId,
      invalidate,
      questions,
      router,
      setData,
      setId,
      setTitle,
      startedAt,
      stopwatch,
      timed,
      totalSeconds,
      recordOfficialAttempt,
      returnTo,
      usesProvidedQuestions
    ]
  );

  useEffect(() => {
    if (questions.length === 0) return;
    setCurrentIndex((index) => Math.min(index, questions.length - 1));
  }, [questions.length]);

  useEffect(() => {
    if (!timed || loading || result || submitting || questions.length === 0) return;

    const timer = window.setInterval(() => {
      setRemainingSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [loading, questions.length, result, submitting, timed]);

  // Positive timer for untimed wrong-question practice (history practice).
  useEffect(() => {
    if (!stopwatch || timed || loading || result || submitting || questions.length === 0) {
      return;
    }
    if (timerPaused) {
      setElapsedDisplaySeconds(elapsedBaseRef.current);
      return;
    }
    if (elapsedRunStartedRef.current === null) {
      elapsedRunStartedRef.current = Date.now();
    }
    const update = () => {
      const runStartedAt = elapsedRunStartedRef.current;
      if (runStartedAt === null) return;
      setElapsedDisplaySeconds(
        elapsedBaseRef.current + Math.max(0, Math.round((Date.now() - runStartedAt) / 1000))
      );
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => {
      window.clearInterval(timer);
      const runStartedAt = elapsedRunStartedRef.current;
      if (runStartedAt !== null) {
        elapsedBaseRef.current += Math.max(
          0,
          Math.round((Date.now() - runStartedAt) / 1000)
        );
        elapsedDisplayRef.current = elapsedBaseRef.current;
        elapsedRunStartedRef.current = null;
      }
    };
  }, [loading, questions.length, result, stopwatch, submitting, timed, timerPaused]);

  // Persisted Grammar sessions save a recoverable answer/progress snapshot.
  // Ordinary PracticeSession callers do not pass onProgress and are unchanged.
  useEffect(() => {
    if (
      !onProgressRef.current ||
      loading ||
      result ||
      submitting ||
      questions.length === 0
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      const snapshot = buildProgressSnapshot(
        questions,
        draftAnswers,
        questionTimes,
        currentIndex,
        currentAnswer,
        startedAt,
        totalSeconds,
        stopwatch && !timed ? elapsedDisplayRef.current : undefined,
        timerPaused
      );
      latestProgressRef.current = snapshot;
      onProgressRef.current?.(snapshot);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    currentAnswer,
    currentIndex,
    draftAnswers,
    loading,
    questionTimes,
    questions,
    result,
    startedAt,
    stopwatch,
    submitting,
    timed,
    timerPaused,
    totalSeconds
  ]);

  // Positive category Assignments store elapsed time even while the Student is
  // idle. Answer/navigation changes still save immediately through the effect
  // above; this is only a bounded elapsed-time checkpoint.
  useEffect(() => {
    if (
      !onProgressRef.current ||
      !stopwatch ||
      timed ||
      loading ||
      result ||
      submitting ||
      questions.length === 0
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      const snapshot = buildProgressSnapshot(
        questions,
        draftAnswers,
        questionTimes,
        currentIndex,
        currentAnswer,
        startedAt,
        totalSeconds,
        elapsedDisplayRef.current,
        timerPaused
      );
      latestProgressRef.current = snapshot;
      onProgressRef.current?.(snapshot);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [
    currentAnswer,
    currentIndex,
    draftAnswers,
    loading,
    questionTimes,
    questions,
    result,
    startedAt,
    stopwatch,
    submitting,
    timed,
    timerPaused,
    totalSeconds
  ]);

  useEffect(() => {
    if (!onProgressRef.current) return;
    const flush = () => {
      if (latestProgressRef.current) {
        onProgressRef.current?.(latestProgressRef.current);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (!timed || remainingSeconds !== 0 || loading || result || submitting || questions.length === 0) {
      return;
    }

    const { savedAnswers } = saveCurrentProgress();
    submitAll(savedAnswers, totalSeconds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentQuestionId,
    currentAnswer,
    draftAnswers,
    loading,
    questionTimes,
    questions.length,
    questionStartedAt,
    remainingSeconds,
    result,
    submitting,
    submitAll
  ]);

  const optionChunks = useMemo(
    () =>
      currentQuestion
        ? splitTextItems(currentQuestion.options_text).map((text, index) => ({
            id: `${currentQuestion.question_id}-${index}`,
            text
          }))
        : [],
    [currentQuestion]
  );

  useEffect(() => {
    if (!currentQuestionId) return;
    setVisitedQuestionIds((ids) => new Set(ids).add(currentQuestionId));
    setCurrentAnswer(
      normalizeOptionAnswer(draftAnswers[currentQuestionId], currentBlankCount)
    );
    setQuestionStartedAt(Date.now());
  }, [currentQuestionId, currentBlankCount, draftAnswers]);

  const isLastQuestion = currentIndex === questions.length - 1;

  function buildSavedAnswers(nextDraftAnswers: DraftAnswers, nextQuestionTimes: QuestionTimes) {
    return questions.reduce<SavedAnswers>((answers, question) => {
      const answer = normalizeOptionAnswer(
        nextDraftAnswers[question.question_id],
        question.blank_count
      );
      answers[question.question_id] = {
        chunks: answer.map((chunk) => chunk?.text ?? ""),
        questionTimeSeconds: nextQuestionTimes[question.question_id] ?? 0
      };
      return answers;
    }, {});
  }

  function saveCurrentProgress() {
    if (!currentQuestion) {
      return {
        nextDraftAnswers: draftAnswers,
        nextQuestionTimes: questionTimes,
        savedAnswers: buildSavedAnswers(draftAnswers, questionTimes)
      };
    }

    const questionId = currentQuestion.question_id;
    const nextDraftAnswers = {
      ...draftAnswers,
      [questionId]: normalizeOptionAnswer(currentAnswer, currentQuestion.blank_count)
    };
    const nextQuestionTimes = {
      ...questionTimes,
      [questionId]: (questionTimes[questionId] ?? 0) + elapsedQuestionSeconds(questionStartedAt)
    };

    setDraftAnswers(nextDraftAnswers);
    setQuestionTimes(nextQuestionTimes);
    setQuestionStartedAt(Date.now());

    return {
      nextDraftAnswers,
      nextQuestionTimes,
      savedAnswers: buildSavedAnswers(nextDraftAnswers, nextQuestionTimes)
    };
  }

  function dropChunk(blankIndex: number, chunkId: string) {
    if (!currentQuestion || result || submitting) return;
    const chunk = optionChunks.find((item) => item.id === chunkId);
    if (!chunk) return;

    setCurrentAnswer((answer) => {
      const usedInAnotherBlank = answer.some(
        (item, index) => index !== blankIndex && item?.id === chunk.id
      );
      if (usedInAnotherBlank) return answer;

      const next = [...answer];
      next[blankIndex] = chunk;
      return next;
    });
  }

  function removeAnswer(index: number) {
    if (result || submitting) return;
    setCurrentAnswer((answer) => {
      const next = [...answer];
      next[index] = null;
      return next;
    });
  }

  async function goNext() {
    if (!currentQuestion) return;
    const { savedAnswers } = saveCurrentProgress();
    if (isLastQuestion) {
      await submitAll(savedAnswers);
      return;
    }

    setCurrentIndex((index) => index + 1);
  }

  async function endPractice() {
    const { savedAnswers } = saveCurrentProgress();
    const practicedQuestionIds = questions
      .map((question) => question.question_id)
      .filter((questionId) => visitedQuestionIds.has(questionId));

    if (practicedQuestionIds.length === 0) {
      setError("No questions practiced yet.");
      return;
    }

    await submitAll(savedAnswers, undefined, submitAnsweredOnly ? practicedQuestionIds : undefined);
  }

  function goBack() {
    if (currentIndex === 0) return;
    saveCurrentProgress();
    setShowReview(false);
    setCurrentIndex((index) => index - 1);
  }

  function openReview() {
    saveCurrentProgress();
    setShowReview(true);
  }

  function jumpToQuestion(index: number) {
    const question = questions[index];
    if (!question) return;

    setCurrentIndex(index);
    setCurrentAnswer(
      normalizeOptionAnswer(draftAnswers[question.question_id], question.blank_count)
    );
    setQuestionStartedAt(Date.now());
    setShowReview(false);
  }

  if (startLoading) {
    return <p className="student-loading">正在验证练习权限...</p>;
  }

  if (requiresPracticeStart && startStatus === "error") {
    return <p className="student-error-state">{startError}</p>;
  }

  if (loading) {
    return <p className="student-loading">Loading questions...</p>;
  }

  if (displayError && questions.length === 0) {
    return <p className="student-error-state">{displayError}</p>;
  }

  if (!currentQuestion) {
    return <p className="student-empty">No questions found.</p>;
  }

  return (
    <div className="student-practice-workspace space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-student-border bg-white px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-student-primary">
            Question {currentIndex + 1}/{questions.length}
          </p>
          {result ? (
            <p className="mt-1 text-lg font-bold">
              Score: {result.correctCount}/{result.total}
            </p>
          ) : null}
        </div>
        {timed ? (
          <div className="rounded-xl border border-student-primary-border bg-student-primary-soft px-4 py-2 text-right">
            <p className="text-xs font-semibold uppercase text-student-muted">Time left</p>
            <p className="font-mono text-xl font-bold">{formatTime(remainingSeconds)}</p>
          </div>
        ) : stopwatch ? (
          <div className="rounded-xl border border-student-primary-border bg-student-primary-soft px-4 py-2 text-right">
            <p className="text-xs font-semibold uppercase text-student-muted">Time</p>
            <p className="font-mono text-xl font-bold" data-testid="practice-elapsed-time">
              {formatTime(elapsedDisplaySeconds)}
            </p>
            {allowPause ? (
              <button
                className="mt-1 text-xs font-semibold text-student-primary underline-offset-4 hover:underline disabled:opacity-50"
                disabled={Boolean(result) || submitting}
                onClick={() => setTimerPaused((paused) => !paused)}
                type="button"
              >
                {timerPaused ? "继续计时" : "暂停"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {displayError ? <p className="student-error-state">{displayError}</p> : null}

      {showReview ? (
        <PracticeReview
          currentIndex={currentIndex}
          items={questions.map((question, index) => {
            const answer = normalizeOptionAnswer(
              draftAnswers[question.question_id],
              question.blank_count
            );
            return {
              completed: answer.length === question.blank_count && answer.every(Boolean),
              key: question.question_id,
              label: `Question ${index + 1}`
            };
          })}
          onSelect={jumpToQuestion}
        />
      ) : (
        <LexicalLookupProvider pageMode="practice" access={{ kind: "bas_prompt", setId, questionId: currentQuestion.question_id }} sourceType="bas">
        <QuestionDisplay
          lexicalPrompt
          answers={currentAnswer}
          disabled={Boolean(result) || submitting}
          hideQuestionNumber={hideQuestionCardNumber}
          onDropChunk={dropChunk}
          onRemoveAnswer={removeAnswer}
          options={optionChunks}
          prompt={currentQuestion.prompt}
          questionNumber={currentQuestion.question_order}
          template={currentQuestion.sentence_template}
        />
        </LexicalLookupProvider>
      )}

      <div className="flex flex-wrap justify-end gap-3">
        {allowEndPractice ? (
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[10px] border border-student-error-border bg-white px-5 py-3 font-semibold text-student-error transition hover:border-student-error hover:bg-student-error-soft disabled:cursor-not-allowed disabled:opacity-60"
            disabled={submitting || Boolean(result)}
            onClick={endPractice}
            type="button"
          >
            End Practice
          </button>
        ) : null}
        <button
          className="student-button-secondary min-h-11 px-5 py-3 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={submitting || Boolean(result)}
          onClick={openReview}
          type="button"
        >
          Review
        </button>
        {currentIndex > 0 ? (
          <button
            className="student-button-secondary min-h-11 px-5 py-3 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={submitting || Boolean(result)}
            onClick={goBack}
            type="button"
          >
            Back
          </button>
        ) : null}
        <button
          className="student-button-primary min-h-11 px-5 py-3 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={submitting || Boolean(result)}
          onClick={goNext}
          type="button"
        >
          {submitting ? "Submitting..." : "Next"}
        </button>
      </div>
    </div>
  );
}

async function loadPracticeQuestions(setId: string, session: StudentCacheSession) {
  const url = `/api/sets/${encodeURIComponent(setId)}/questions`;
  return measureStudentRequest(`GET ${url}`, async (captureResponse) => {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`
      }
    });
    captureResponse(response);
    const responseText = await response.text();
    let payload: QuestionsPayload;

    try {
      payload = responseText
        ? JSON.parse(responseText)
        : { error: "The questions API returned an empty response." };
    } catch {
      payload = { error: "The questions API returned invalid JSON." };
    }

    if (!response.ok || payload.error) {
      throw new Error(payload.error ?? "Could not load questions.");
    }

    return payload;
  });
}

function formatTime(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function elapsedQuestionSeconds(startedAt: number) {
  return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
}

function isSubmitResponse(value: Partial<SubmitResponse>): value is SubmitResponse {
  return (
    typeof value.attemptId === "string" &&
    typeof value.correctCount === "number" &&
    typeof value.total === "number" &&
    typeof value.accuracy === "number" &&
    typeof value.timeSpentSeconds === "number" &&
    Array.isArray(value.results)
  );
}

function hydratePracticeDraft(
  questions: PublicQuestion[],
  draft: PracticeSessionInitialDraft | undefined
) {
  const answers: DraftAnswers = {};
  const questionTimes: QuestionTimes = {};

  for (const question of questions) {
    const savedAnswer = draft?.answers?.[question.question_id];
    if (Array.isArray(savedAnswer)) {
      const chunks = splitTextItems(question.options_text).map((text, index) => ({
        id: `${question.question_id}-${index}`,
        text
      }));
      const used = new Set<number>();
      answers[question.question_id] = Array.from(
        { length: question.blank_count },
        (_, blankIndex) => {
          const savedText = savedAnswer[blankIndex];
          if (typeof savedText !== "string" || !savedText) return null;
          const chunkIndex = chunks.findIndex(
            (chunk, index) => !used.has(index) && chunk.text === savedText
          );
          if (chunkIndex === -1) return null;
          used.add(chunkIndex);
          return chunks[chunkIndex];
        }
      );
    }

    const savedTime = draft?.questionTimes?.[question.question_id];
    if (typeof savedTime === "number" && Number.isFinite(savedTime) && savedTime >= 0) {
      questionTimes[question.question_id] = Math.round(savedTime);
    }
  }

  const savedIndex =
    typeof draft?.currentIndex === "number" && Number.isInteger(draft.currentIndex)
      ? draft.currentIndex
      : 0;
  return {
    answers,
    questionTimes,
    currentIndex:
      questions.length === 0
        ? 0
        : Math.max(0, Math.min(questions.length - 1, savedIndex))
  };
}

function buildProgressSnapshot(
  questions: PublicQuestion[],
  draftAnswers: DraftAnswers,
  questionTimes: QuestionTimes,
  currentIndex: number,
  currentAnswer: Array<OptionChunk | null>,
  startedAt: number,
  totalSeconds: number,
  elapsedOverride?: number,
  paused?: boolean
): PracticeProgressSnapshot {
  const nextDraftAnswers = { ...draftAnswers };
  const currentQuestion = questions[currentIndex];
  if (currentQuestion) {
    nextDraftAnswers[currentQuestion.question_id] = normalizeOptionAnswer(
      currentAnswer,
      currentQuestion.blank_count
    );
  }

  return {
    answers: Object.fromEntries(
      questions.map((question) => [
        question.question_id,
        (nextDraftAnswers[question.question_id] ?? [])
          .map((chunk) => chunk?.text ?? "")
          .slice(0, question.blank_count)
      ])
    ),
    questionTimes: Object.fromEntries(
      questions
        .map((question) => [
          question.question_id,
          Math.max(0, Math.round(questionTimes[question.question_id] ?? 0))
        ])
        .filter(([, seconds]) => Number.isFinite(seconds))
    ),
    currentIndex,
    elapsedSeconds: elapsedOverride !== undefined
      ? Math.max(0, Math.round(elapsedOverride))
      : Math.min(
          totalSeconds,
          Math.max(0, Math.round((Date.now() - startedAt) / 1000))
        ),
    ...(paused ? { paused: true } : {})
  };
}

function normalizeOptionAnswer(
  answer: Array<OptionChunk | null> | undefined,
  blankCount: number
) {
  return Array.from({ length: blankCount }, (_, index) => answer?.[index] ?? null);
}
