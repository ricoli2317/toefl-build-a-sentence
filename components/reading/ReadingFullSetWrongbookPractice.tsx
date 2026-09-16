"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent
} from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { formatWritingTimer } from "@/lib/writing";
import { buildReadingSubmissionAnswers } from "@/lib/reading/attempts";
import { readingLookupEnabled } from "@/lib/reading/lookupCapabilities";
import { setReadingAnswer, type ReadingAnswer, type ReadingAnswerState } from "@/lib/reading/practiceState";
import type { StudentReadingPracticePayload } from "@/lib/reading/studentPractice";
import {
  buildReadingWrongbookInitialAnswers,
  isReadingFullSetWrongbookAttemptSummary,
  readingWrongbookEditableSlotIds,
  selectReadingWrongbookPractice,
  selectReadingWrongbookSubmissionAnswers,
  type ReadingFullSetWrongbookAttemptSummary,
  type ReadingWrongbookPreservedAnswer,
  type ReadingWrongbookScope
} from "@/lib/reading/wrongbook";
import {
  buildReadingFullSetWrongbookProgress,
  readingFullSetWrongbookProgressLabel,
  sameReadingFullSetWrongbookTarget,
  sameReadingFullSetWrongbookTargets,
  type ReadingFullSetWrongbookQueueItem,
  type ReadingFullSetWrongbookTarget
} from "@/lib/wrongQuestions";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { invalidateStudentWrongbook } from "@/lib/studentCacheEvents";
import {
  logStudentPerformance,
  measureStudentRequest,
  useStudentPagePerformance
} from "@/lib/studentPerformance.client";
import {
  studentWrongQuestionsCacheKey,
  useStudentCachedData,
  useStudentDataCache,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { ReadingFullSetImagePreloadCache } from "@/lib/reading/fullSetOccurrenceCache.client";
import {
  ReadingPracticeHeader,
  ReadingQuestionViewport,
  ReadingWorkspaceRouter,
  readingShellStyle,
  readingTwoColumnScaleStyle
} from "./ReadingPractice";

type LoadedOccurrence = {
  answers: ReadingAnswerState;
  occurrenceId: string;
  practice: StudentReadingPracticePayload;
  targets: ReadingFullSetWrongbookTarget[];
};

type Step = ReturnType<typeof buildReadingFullSetWrongbookProgress>["screens"][number];

export function ReadingFullSetWrongbookPractice({
  scope,
  sourceAttemptId
}: {
  scope: ReadingWrongbookScope;
  sourceAttemptId: string;
}) {
  const router = useRouter();
  const studentDataCache = useStudentDataCache();
  const [todayRange] = useState(localDayRange);
  const bootstrapKey = studentWrongQuestionsCacheKey(
    `full-set-correction:${scope}:${sourceAttemptId}:${todayRange.start}`
  );
  const bootstrap = useStudentCachedData<Awaited<ReturnType<typeof loadFullSetCorrection>>>(
    bootstrapKey,
    (session) => loadFullSetCorrection({
      scope,
      session,
      sourceAttemptId,
      todayEnd: todayRange.end,
      todayStart: todayRange.start
    })
  );
  const attempt = bootstrap.data?.attempt ?? null;
  const item = bootstrap.data?.item ?? null;
  const [occurrences, setOccurrences] = useState<Record<string, LoadedOccurrence>>({});
  const [stepIndex, setStepIndex] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [answerableStepKey, setAnswerableStepKey] = useState("");
  const performanceStartedAtRef = useRef(performance.now());
  const startedAtRef = useRef(Date.now());
  const questionStartedAtRef = useRef(Date.now());
  const activeQuestionKeyRef = useRef("");
  const questionTimesRef = useRef<Record<string, number>>({});
  const firstPhaseRef = useRef(new Set<string>());
  const preloadedTargetRef = useRef(new Set<string>());
  const imagePreloadCacheRef = useRef(new ReadingFullSetImagePreloadCache());
  const workspaceRef = useRef<HTMLElement | null>(null);

  const logFirstPhase = useCallback((event: string, detail: Record<string, unknown> = {}) => {
    if (firstPhaseRef.current.has(event)) return;
    firstPhaseRef.current.add(event);
    logStudentPerformance({
      elapsedMs: Math.round((performance.now() - performanceStartedAtRef.current) * 10) / 10,
      event,
      sourceAttemptId,
      ...detail
    });
  }, [sourceAttemptId]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => logFirstPhase("wrongbook_page_shell_visible"));
    return () => cancelAnimationFrame(frame);
  }, [logFirstPhase]);

  useEffect(() => () => imagePreloadCacheRef.current.clear(), []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000)));
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  const progress = useMemo(
    () => buildReadingFullSetWrongbookProgress(attempt?.targets ?? []),
    [attempt?.targets]
  );
  const steps: Step[] = progress.screens;
  const step = steps[stepIndex];
  const stepTarget = step
    ? item?.targets.find((target) =>
        target.occurrenceId === step.occurrenceId && target.questionId === step.questionId
      )
    : undefined;
  const embeddedFirstPractice = bootstrap.data?.firstPractice ?? null;
  const bootstrapPractice = stepTarget?.logicalItemId === embeddedFirstPractice?.item.itemId
    ? embeddedFirstPractice
    : null;
  const practiceKey = studentWrongQuestionsCacheKey(
    `full-set-correction-practice:${stepTarget?.logicalItemId ?? "pending"}`
  );
  const sourcePractice = useStudentCachedData<StudentReadingPracticePayload>(
    practiceKey,
    (session) => loadReadingPractice(stepTarget!.logicalItemId, session),
    { enabled: Boolean(stepTarget && !bootstrapPractice) }
  );
  const sourcePracticeData = bootstrapPractice ?? sourcePractice.data;

  useEffect(() => {
    if (!step || !item || !sourcePracticeData || occurrences[step.occurrenceId]) return;
    const targets = item.targets.filter((target) => target.occurrenceId === step.occurrenceId);
    const practice = selectReadingWrongbookPractice(sourcePracticeData, targets);
    setOccurrences((current) => ({
      ...current,
      [step.occurrenceId]: {
        answers: buildReadingWrongbookInitialAnswers(
          practice,
          bootstrap.data?.preservedAnswersByOccurrence?.[step.occurrenceId] ?? []
        ),
        occurrenceId: step.occurrenceId,
        practice,
        targets
      }
    }));
  }, [bootstrap.data?.preservedAnswersByOccurrence, item, occurrences, sourcePracticeData, step]);

  useEffect(() => {
    if (!bootstrap.data) return;
    startedAtRef.current = Date.now();
  }, [bootstrap.data]);

  const current = step ? occurrences[step.occurrenceId] ?? null : null;
  const currentQuestion = current?.practice.questions.find((question) => question.questionId === step?.questionId);
  const currentOccurrenceId = current?.occurrenceId ?? "";
  const currentQuestionId = currentQuestion?.questionId ?? "";
  const currentModule = current?.practice.item.module;
  const currentStepKey = step ? `${step.occurrenceId}:${step.questionId}` : "";
  const currentAnswerable = Boolean(currentStepKey && answerableStepKey === currentStepKey);
  const currentTargets = current?.targets;
  const editableSlotIds = useMemo(
    () => currentModule === "ctw" && currentTargets
      ? readingWrongbookEditableSlotIds(currentTargets)
      : undefined,
    [currentModule, currentTargets]
  );
  const loadError = bootstrap.error || sourcePractice.error;
  useStudentPagePerformance({
    errors: [error, loadError],
    loading: !attempt || !current || !currentQuestion,
    route: `/student/wrong-questions/${scope}/reading/practice?${new URLSearchParams({
      sourceAttemptId,
      taskType: "full_set"
    }).toString()}`
  });

  useEffect(() => {
    if (stepIndex !== 0 || !currentQuestion || !currentModule) return;
    const frame = requestAnimationFrame(() => logFirstPhase("wrongbook_first_question_options_visible", {
      taskType: currentModule
    }));
    return () => cancelAnimationFrame(frame);
  }, [currentModule, currentQuestion, logFirstPhase, stepIndex]);

  useEffect(() => {
    if (stepIndex !== 0 || currentModule !== "rdl") return;
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const recordSelectionReady = () => {
      if (!workspace.querySelector('[data-testid="rdl-selection-surface"]')) return;
      logFirstPhase("wrongbook_rdl_selection_ready", { taskType: "rdl" });
    };
    recordSelectionReady();
    const observer = new MutationObserver(recordSelectionReady);
    observer.observe(workspace, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [currentModule, logFirstPhase, stepIndex]);

  const handleWorkspaceReady = useCallback(() => {
    if (!currentStepKey) return;
    setAnswerableStepKey(currentStepKey);
    if (stepIndex === 0) {
      if (currentModule === "rdl") {
        logFirstPhase("wrongbook_rdl_selection_ready", { taskType: "rdl" });
      }
      logFirstPhase("wrongbook_first_question_fully_answerable", {
        taskType: currentModule ?? null
      });
    }
  }, [currentModule, currentStepKey, logFirstPhase, stepIndex]);

  const handleWorkspaceAssetLoad = useCallback((event: SyntheticEvent<HTMLElement>) => {
    if (stepIndex !== 0 || currentModule !== "rdl" || !(event.target instanceof HTMLImageElement)) return;
    const image = event.target;
    void Promise.resolve(typeof image.decode === "function" ? image.decode() : undefined).then(() => {
      const resource = performance.getEntriesByName(image.currentSrc || image.src).at(-1) as PerformanceResourceTiming | undefined;
      logFirstPhase("wrongbook_rdl_material_image_visible", {
        browserDurationMs: resource ? Math.round(resource.duration * 10) / 10 : null,
        decodedBodyBytes: resource?.decodedBodySize ?? null,
        taskType: "rdl",
        transferBytes: resource?.transferSize ?? null
      });
    }).catch(() => undefined);
  }, [currentModule, logFirstPhase, stepIndex]);

  useEffect(() => {
    if (!currentStepKey || answerableStepKey !== currentStepKey || !item || !current) return;
    const nextStep = steps[stepIndex + 1];
    if (!nextStep || nextStep.occurrenceId === current.occurrenceId) return;
    const nextTarget = item.targets.find((target) =>
      target.occurrenceId === nextStep.occurrenceId && target.questionId === nextStep.questionId
    );
    if (!nextTarget) return;
    const preloadIdentity = `${nextTarget.occurrenceId}:${nextTarget.logicalItemId}`;
    if (preloadedTargetRef.current.has(preloadIdentity)) return;
    preloadedTargetRef.current.add(preloadIdentity);
    const nextPracticeKey = studentWrongQuestionsCacheKey(
      `full-set-correction-practice:${nextTarget.logicalItemId}`
    );
    logStudentPerformance({
      event: "wrongbook_next_target_preload_started",
      taskType: nextTarget.taskType
    });
    void studentDataCache.load<StudentReadingPracticePayload>(
      nextPracticeKey,
      (session) => loadReadingPractice(nextTarget.logicalItemId, session, "preload")
    ).then((practice) => {
      if (!practice) {
        logStudentPerformance({
          event: "wrongbook_next_target_preload_failed",
          taskType: nextTarget.taskType
        });
        return;
      }
      logStudentPerformance({
        event: "wrongbook_next_target_practice_ready",
        taskType: nextTarget.taskType
      });
      if (practice.item.module !== "rdl" || !practice.material) return;
      return imagePreloadCacheRef.current.acquire(practice.material.imageUrl).promise.then(
        () => logStudentPerformance({
          event: "wrongbook_next_target_rdl_image_ready",
          taskType: "rdl"
        }),
        () => logStudentPerformance({
          event: "wrongbook_next_target_rdl_image_preload_failed",
          taskType: "rdl"
        })
      );
    });
  }, [answerableStepKey, current, currentStepKey, item, stepIndex, steps, studentDataCache]);

  useEffect(() => {
    activeQuestionKeyRef.current = currentOccurrenceId && currentQuestionId
      ? `${currentOccurrenceId}:${currentQuestionId}`
      : "";
    questionStartedAtRef.current = Date.now();
  }, [currentOccurrenceId, currentQuestionId]);

  function captureTime() {
    const key = activeQuestionKeyRef.current;
    if (key) questionTimesRef.current[key] = (questionTimesRef.current[key] ?? 0)
      + Math.max(0, Math.round((Date.now() - questionStartedAtRef.current) / 1000));
    questionStartedAtRef.current = Date.now();
  }

  function move(direction: -1 | 1) {
    captureTime();
    setStepIndex((value) => Math.max(0, Math.min(steps.length - 1, value + direction)));
  }

  function updateAnswer(questionId: string, answer: ReadingAnswer) {
    if (!current || (current.practice.item.module === "rdl" && !currentAnswerable)) return;
    setOccurrences((values) => ({
      ...values,
      [current.occurrenceId]: {
        ...current,
        answers: setReadingAnswer(current.answers, questionId, answer)
      }
    }));
  }

  async function submit() {
    if (!attempt || submitting) return;
    captureTime();
    setSubmitting(true);
    setError("");
    try {
      const { data: { session } } = await createBrowserSupabase().auth.getSession();
      if (!session) throw new Error("请先登录后再提交错题订正。");
      const answers = Object.values(occurrences).flatMap((occurrence) => selectReadingWrongbookSubmissionAnswers(
        buildReadingSubmissionAnswers(
          occurrence.practice,
          occurrence.answers,
          Object.fromEntries(occurrence.practice.questions.map((question) => [
            question.questionId,
            questionTimesRef.current[`${occurrence.occurrenceId}:${question.questionId}`] ?? 0
          ]))
        ),
        occurrence.targets
      ).map((answer) => ({
        ...answer,
        logicalItemId: occurrence.practice.item.itemId,
        occurrenceId: occurrence.occurrenceId
      })));
      const response = await fetch(`/api/reading/wrongbook-attempts/${encodeURIComponent(attempt.attemptId)}/submit`, {
        method: "POST",
        cache: "no-store",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          answers,
          elapsedSeconds,
          sourceAttemptId: attempt.sourceAttemptId,
          sourceFullSetId: attempt.sourceFullSetId,
          taskType: "full_set"
        })
      });
      const payload = await response.json().catch(() => ({})) as { attempt?: unknown; error?: string };
      if (!response.ok || !isReadingFullSetWrongbookAttemptSummary(payload.attempt)) {
        throw new Error(payload.error ?? "错题订正提交失败，请稍后重试。");
      }
      invalidateStudentWrongbook(session.user.id);
      router.replace(`/student/reading/wrongbook-results/${encodeURIComponent(attempt.attemptId)}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "错题订正提交失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  if ((error || loadError) && !current) {
    return <Message description={error || loadError} onBack={() => router.push(STUDENT_ROUTES.wrongQuestions)} />;
  }
  if (!attempt || !current || !currentQuestion) return <Message description="正在加载错题和原题练习界面..." />;
  return (
    <div className="reading-theme h-[100dvh] overflow-hidden bg-[#fbfbfe] text-student-text" style={readingShellStyle}>
      <ReadingPracticeHeader
        elapsedSeconds={elapsedSeconds}
        onBack={() => router.push(STUDENT_ROUTES.wrongQuestions)}
        progressLabel={`Module ${current.targets[0]?.moduleNumber} · ${readingFullSetWrongbookProgressLabel(step, progress.wrongQuestionCount)}`}
        title={`错题订正 · ${item?.title}`}
      />
      <main className="mx-auto h-[calc(100dvh-var(--reading-header-height))] min-h-0" style={readingTwoColumnScaleStyle}>
        <ReadingQuestionViewport
          canGoNext={stepIndex < steps.length - 1}
          canGoPrevious={stepIndex > 0}
          module={current.practice.item.module}
          onNext={() => move(1)}
          onPrevious={() => move(-1)}
          onSubmit={submit}
          readOnly={false}
          submitError={error}
          submitting={submitting}
        >
          <section
            aria-busy={current.practice.item.module === "rdl" && !currentAnswerable}
            className={`flex h-full min-h-0 flex-col ${current.practice.item.module === "rdl" && !currentAnswerable ? "[&_button]:pointer-events-none [&_button]:opacity-60" : ""}`}
            onClickCapture={(event) => {
              if (current.practice.item.module !== "rdl" || currentAnswerable) return;
              event.preventDefault();
              event.stopPropagation();
            }}
            onLoadCapture={handleWorkspaceAssetLoad}
            ref={workspaceRef}
          >
            <ReadingWorkspaceRouter
              answers={current.answers}
              currentQuestion={currentQuestion}
              editableSlotIds={editableSlotIds}
              lookupEnabled={readingLookupEnabled("active", current.practice.item.module)}
              onAnswerChange={updateAnswer}
              onReady={handleWorkspaceReady}
              practice={current.practice}
              readOnly={false}
            />
          </section>
        </ReadingQuestionViewport>
      </main>
    </div>
  );
}

async function loadFullSetCorrection(input: {
  scope: ReadingWrongbookScope;
  session: StudentCacheSession;
  sourceAttemptId: string;
  todayEnd: string;
  todayStart: string;
}) {
  return measureStudentRequest("POST /api/reading/wrongbook-attempts (Full Set bootstrap)", async (captureResponse) => {
    const response = await fetch("/api/reading/wrongbook-attempts", {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${input.session.accessToken}`,
        "Content-Type": "application/json",
        ...(process.env.NODE_ENV !== "production"
          ? { "X-TPS-Performance-Debug": "1" }
          : {})
      },
      body: JSON.stringify({
        scope: input.scope,
        sourceAttemptId: input.sourceAttemptId,
        taskType: "full_set",
        todayEnd: input.todayEnd,
        todayStart: input.todayStart
      })
    });
    captureResponse(response);
    const payload = await response.json().catch(() => ({})) as {
      attempt?: unknown;
      error?: string;
      firstPractice?: StudentReadingPracticePayload;
      firstTarget?: ReadingFullSetWrongbookTarget;
      item?: ReadingFullSetWrongbookQueueItem;
      preservedAnswersByOccurrence?: Record<string, ReadingWrongbookPreservedAnswer[]>;
    };
    if (!response.ok || !isReadingFullSetWrongbookAttemptSummary(payload.attempt)) {
      throw new Error(payload.error ?? "错题订正记录加载失败，请稍后重试。");
    }
    if (payload.attempt.sourceAttemptId !== input.sourceAttemptId) {
      throw new Error("错题订正记录与当前套题不一致。");
    }
    if (!payload.item || payload.item.sourceAttemptId !== input.sourceAttemptId) {
      throw new Error("这套错题已经订正完成。");
    }
    if (
      !payload.firstTarget
      || !payload.firstPractice
      || payload.firstPractice.item.itemId !== payload.firstTarget.logicalItemId
      || !sameReadingFullSetWrongbookTarget(payload.firstTarget, payload.item.targets[0])
      || !sameReadingFullSetWrongbookTargets(payload.attempt.targets, payload.item.targets)
    ) {
      throw new Error("首题内容加载失败，请稍后重试。");
    }
    return {
      attempt: payload.attempt,
      firstPractice: payload.firstPractice,
      firstTarget: payload.firstTarget,
      item: payload.item,
      preservedAnswersByOccurrence: payload.preservedAnswersByOccurrence ?? {}
    };
  });
}

async function loadReadingPractice(
  itemId: string,
  session: StudentCacheSession,
  purpose: "navigation" | "preload" = "navigation"
) {
  const path = `/api/reading/wrongbook-attempts/practice/${encodeURIComponent(itemId)}`;
  return measureStudentRequest(`GET ${path} (Full Set wrongbook ${purpose})`, async (captureResponse) => {
    const response = await fetch(path, {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        ...(process.env.NODE_ENV !== "production"
          ? { "X-TPS-Performance-Debug": "1" }
          : {})
      }
    });
    captureResponse(response);
    const payload = await response.json().catch(() => ({})) as {
      error?: string;
      practice?: StudentReadingPracticePayload;
    };
    if (!response.ok || !payload.practice) {
      throw new Error(payload.error ?? "阅读错题内容加载失败，请稍后重试。");
    }
    return payload.practice;
  });
}

function Message({ description, onBack }: { description: string; onBack?: () => void }) {
  return <main className="reading-theme flex min-h-screen items-center justify-center bg-[#fbfbfe] px-5"><section className="student-card max-w-lg p-8 text-center"><h1 className="text-2xl font-bold">错题订正</h1><p className="mt-3 text-sm text-student-muted">{description}</p>{onBack ? <button className="student-button-primary mt-6" onClick={onBack} type="button">返回错题集</button> : null}</section></main>;
}

function localDayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { end: end.toISOString(), start: start.toISOString() };
}
