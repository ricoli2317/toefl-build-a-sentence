"use client";

import { ArrowLeft, ChevronLeft, ChevronRight, Clock3 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  type ReadingFullSetWrongbookQueueItem,
  type ReadingFullSetWrongbookTarget
} from "@/lib/wrongQuestions";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { invalidateStudentWrongbook } from "@/lib/studentCacheEvents";
import {
  studentWrongQuestionsCacheKey,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { ReadingWorkspaceRouter, readingTwoColumnScaleStyle } from "./ReadingPractice";

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
  const startedAtRef = useRef(Date.now());
  const questionStartedAtRef = useRef(Date.now());
  const activeQuestionKeyRef = useRef("");
  const questionTimesRef = useRef<Record<string, number>>({});

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
  const practiceKey = studentWrongQuestionsCacheKey(
    `full-set-correction-practice:${stepTarget?.logicalItemId ?? "pending"}`
  );
  const sourcePractice = useStudentCachedData<StudentReadingPracticePayload>(
    practiceKey,
    (session) => loadReadingPractice(stepTarget!.logicalItemId, session),
    { enabled: Boolean(stepTarget) }
  );

  useEffect(() => {
    if (!step || !item || !sourcePractice.data || occurrences[step.occurrenceId]) return;
    const targets = item.targets.filter((target) => target.occurrenceId === step.occurrenceId);
    const practice = selectReadingWrongbookPractice(sourcePractice.data, targets);
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
  }, [bootstrap.data?.preservedAnswersByOccurrence, item, occurrences, sourcePractice.data, step]);

  useEffect(() => {
    if (!bootstrap.data) return;
    startedAtRef.current = Date.now();
  }, [bootstrap.data]);

  const current = step ? occurrences[step.occurrenceId] ?? null : null;
  const currentQuestion = current?.practice.questions.find((question) => question.questionId === step?.questionId);
  const currentOccurrenceId = current?.occurrenceId ?? "";
  const currentQuestionId = currentQuestion?.questionId ?? "";
  const currentModule = current?.practice.item.module;
  const currentTargets = current?.targets;
  const editableSlotIds = useMemo(
    () => currentModule === "ctw" && currentTargets
      ? readingWrongbookEditableSlotIds(currentTargets)
      : undefined,
    [currentModule, currentTargets]
  );

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
    if (!current) return;
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

  const loadError = bootstrap.error || sourcePractice.error;
  if ((error || loadError) && !current) {
    return <Message description={error || loadError} onBack={() => router.push(STUDENT_ROUTES.wrongQuestions)} />;
  }
  if (!attempt || !current || !currentQuestion) return <Message description="正在加载错题和原题练习界面..." />;
  return (
    <div className="min-h-[100dvh] bg-[#fbfbfe] text-student-text">
      <header className="grid h-[76px] grid-cols-[1fr_auto_1fr] items-center border-b border-student-border bg-white px-5">
        <button className="writing-header-back justify-self-start" onClick={() => router.push(STUDENT_ROUTES.wrongQuestions)} type="button">
          <ArrowLeft aria-hidden="true" size={20} /> Back
        </button>
        <p className="max-w-[50vw] truncate text-sm font-bold text-student-primary">错题订正 · {item?.title}</p>
        <div className="flex items-center gap-2 justify-self-end font-mono text-sm font-bold"><Clock3 size={18} />{formatWritingTimer(elapsedSeconds)}</div>
      </header>
      <main className="mx-auto flex min-h-[calc(100dvh-76px)] max-w-[1440px] flex-col px-4 py-4 sm:px-6 lg:px-8"
        style={current.practice.item.module === "ctw" ? undefined : readingTwoColumnScaleStyle}>
        <p className="mb-3 text-center text-sm font-bold text-student-muted">{readingFullSetWrongbookProgressLabel(step, progress.wrongQuestionCount)} · Module {current.targets[0]?.moduleNumber}</p>
        <section className={current.practice.item.module === "ctw"
          ? "flex-1 rounded-2xl border border-student-border bg-white p-5 shadow-sm sm:p-7"
          : "flex flex-1 flex-col bg-white"}>
          <ReadingWorkspaceRouter
            answers={current.answers}
            currentQuestion={currentQuestion}
            editableSlotIds={editableSlotIds}
            lookupEnabled={readingLookupEnabled("active", current.practice.item.module)}
            layoutMode="natural"
            onAnswerChange={updateAnswer}
            practice={current.practice}
            readOnly={false}
          />
        </section>
        <div className="mt-4 grid grid-cols-3 items-center gap-3">
          <button className="student-button-secondary justify-self-start" disabled={stepIndex === 0} onClick={() => move(-1)} type="button"><ChevronLeft size={18} /> Previous</button>
          <p className="text-center text-xs font-semibold text-student-muted">{error}</p>
          {stepIndex < steps.length - 1
            ? <button className="student-button-primary justify-self-end" onClick={() => move(1)} type="button">Next <ChevronRight size={18} /></button>
            : <button className="student-button-primary justify-self-end" disabled={submitting} onClick={submit} type="button">{submitting ? "Submitting..." : "Submit"}</button>}
        </div>
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
  const response = await fetch("/api/reading/wrongbook-attempts", {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${input.session.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      scope: input.scope,
      sourceAttemptId: input.sourceAttemptId,
      taskType: "full_set",
      todayEnd: input.todayEnd,
      todayStart: input.todayStart
    })
  });
  const payload = await response.json().catch(() => ({})) as {
    attempt?: unknown;
    error?: string;
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
  return {
    attempt: payload.attempt,
    item: payload.item,
    preservedAnswersByOccurrence: payload.preservedAnswersByOccurrence ?? {}
  };
}

async function loadReadingPractice(itemId: string, session: StudentCacheSession) {
  const response = await fetch(`/api/reading/practice/${encodeURIComponent(itemId)}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as {
    error?: string;
    practice?: StudentReadingPracticePayload;
  };
  if (!response.ok || !payload.practice) {
    throw new Error(payload.error ?? "阅读错题内容加载失败，请稍后重试。");
  }
  return payload.practice;
}

function Message({ description, onBack }: { description: string; onBack?: () => void }) {
  return <main className="flex min-h-screen items-center justify-center bg-[#fbfbfe] px-5"><section className="student-card max-w-lg p-8 text-center"><h1 className="text-2xl font-bold">错题订正</h1><p className="mt-3 text-sm text-student-muted">{description}</p>{onBack ? <button className="student-button-primary mt-6" onClick={onBack} type="button">返回错题集</button> : null}</section></main>;
}

function localDayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { end: end.toISOString(), start: start.toISOString() };
}
