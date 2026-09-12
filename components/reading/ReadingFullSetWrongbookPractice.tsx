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
  isReadingFullSetWrongbookQueuePayload,
  readingWrongbookEditableSlotIds,
  selectReadingWrongbookPractice,
  selectReadingWrongbookSubmissionAnswers,
  type ReadingFullSetWrongbookAttemptSummary,
  type ReadingFullSetWrongbookQueuePayload,
  type ReadingWrongbookPreservedAnswer,
  type ReadingWrongbookScope
} from "@/lib/reading/wrongbook";
import {
  buildReadingFullSetWrongbookProgress,
  readingFullSetWrongbookProgressLabel,
  type ReadingFullSetWrongbookTarget
} from "@/lib/wrongQuestions";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { useStudentDataCache, STUDENT_WRONG_QUESTIONS_CACHE_PREFIX } from "@/components/StudentDataCache";
import { ReadingWorkspaceRouter, readingTwoColumnScaleStyle } from "./ReadingPractice";

type LoadedOccurrence = {
  answers: ReadingAnswerState;
  occurrenceId: string;
  practice: StudentReadingPracticePayload;
  targets: ReadingFullSetWrongbookTarget[];
};

type Step = ReturnType<typeof buildReadingFullSetWrongbookProgress>["screens"][number] & {
  occurrenceIndex: number;
};

export function ReadingFullSetWrongbookPractice({
  scope,
  sourceAttemptId
}: {
  scope: ReadingWrongbookScope;
  sourceAttemptId: string;
}) {
  const router = useRouter();
  const cache = useStudentDataCache();
  const [todayRange] = useState(localDayRange);
  const [attempt, setAttempt] = useState<ReadingFullSetWrongbookAttemptSummary | null>(null);
  const [title, setTitle] = useState("");
  const [occurrences, setOccurrences] = useState<LoadedOccurrence[]>([]);
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

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { data: { session } } = await createBrowserSupabase().auth.getSession();
        if (!session) throw new Error("请先登录后再开始错题订正。");
        const query = new URLSearchParams({
          scope,
          sourceAttemptId,
          taskType: "full_set",
          todayEnd: todayRange.end,
          todayStart: todayRange.start
        });
        const headers = { Authorization: `Bearer ${session.access_token}` };
        const queueResponse = await fetch(`/api/reading/wrongbook-attempts?${query}`, { cache: "no-store", headers });
        const queuePayload = await queueResponse.json().catch(() => ({})) as ReadingFullSetWrongbookQueuePayload & { error?: string };
        if (!queueResponse.ok || queuePayload.error || !isReadingFullSetWrongbookQueuePayload(queuePayload)) {
          throw new Error(queuePayload.error ?? "错题订正加载失败，请稍后重试。");
        }
        const item = queuePayload.items[0];
        if (!item || item.sourceAttemptId !== sourceAttemptId) throw new Error("这套错题已经订正完成。");

        const uniqueOccurrences = Array.from(new Map(item.targets.map((target) => [target.occurrenceId, target])).values());
        const practiceResults = await Promise.all(uniqueOccurrences.map(async (occurrence) => {
          const response = await fetch(`/api/reading/practice/${encodeURIComponent(occurrence.logicalItemId)}`, { cache: "no-store", headers });
          const payload = await response.json().catch(() => ({})) as { error?: string; practice?: StudentReadingPracticePayload };
          if (!response.ok || !payload.practice) throw new Error(payload.error ?? "阅读错题内容加载失败，请稍后重试。");
          return payload.practice;
        }));
        const attemptResponse = await fetch("/api/reading/wrongbook-attempts", {
          method: "POST",
          cache: "no-store",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            scope,
            sourceAttemptId,
            taskType: "full_set",
            todayEnd: todayRange.end,
            todayStart: todayRange.start
          })
        });
        const attemptPayload = await attemptResponse.json().catch(() => ({})) as {
          attempt?: unknown;
          error?: string;
          preservedAnswersByOccurrence?: Record<string, ReadingWrongbookPreservedAnswer[]>;
        };
        if (!attemptResponse.ok || !isReadingFullSetWrongbookAttemptSummary(attemptPayload.attempt)) {
          throw new Error(attemptPayload.error ?? "错题订正记录加载失败，请稍后重试。");
        }
        if (attemptPayload.attempt.sourceAttemptId !== sourceAttemptId) throw new Error("错题订正记录与当前套题不一致。");

        const loaded = uniqueOccurrences.map((occurrence, index) => {
          const targets = item.targets.filter((target) => target.occurrenceId === occurrence.occurrenceId);
          const practice = selectReadingWrongbookPractice(practiceResults[index], targets);
          return {
            answers: buildReadingWrongbookInitialAnswers(
              practice,
              attemptPayload.preservedAnswersByOccurrence?.[occurrence.occurrenceId] ?? []
            ),
            occurrenceId: occurrence.occurrenceId,
            practice,
            targets
          };
        });
        if (!cancelled) {
          setAttempt(attemptPayload.attempt);
          setTitle(item.title);
          setOccurrences(loaded);
          startedAtRef.current = Date.now();
        }
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "错题订正加载失败，请稍后重试。");
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [scope, sourceAttemptId, todayRange.end, todayRange.start]);

  const progress = useMemo(
    () => buildReadingFullSetWrongbookProgress(attempt?.targets ?? []),
    [attempt?.targets]
  );
  const steps = useMemo(() => progress.screens.flatMap((screen): Step[] => {
    const occurrenceIndex = occurrences.findIndex((occurrence) => occurrence.occurrenceId === screen.occurrenceId);
    return occurrenceIndex >= 0 ? [{ ...screen, occurrenceIndex }] : [];
  }), [occurrences, progress.screens]);
  const step = steps[stepIndex];
  const current = step ? occurrences[step.occurrenceIndex] : null;
  const currentQuestion = current?.practice.questions.find((question) => question.questionId === step?.questionId);
  const currentOccurrenceId = current?.occurrenceId ?? "";
  const currentQuestionId = currentQuestion?.questionId ?? "";

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
    setOccurrences((values) => values.map((occurrence) => occurrence.occurrenceId === current.occurrenceId
      ? { ...occurrence, answers: setReadingAnswer(occurrence.answers, questionId, answer) }
      : occurrence));
  }

  async function submit() {
    if (!attempt || submitting) return;
    captureTime();
    setSubmitting(true);
    setError("");
    try {
      const { data: { session } } = await createBrowserSupabase().auth.getSession();
      if (!session) throw new Error("请先登录后再提交错题订正。");
      const answers = occurrences.flatMap((occurrence) => selectReadingWrongbookSubmissionAnswers(
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
      cache.invalidate(STUDENT_WRONG_QUESTIONS_CACHE_PREFIX);
      router.replace(`/student/reading/wrongbook-results/${encodeURIComponent(attempt.attemptId)}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "错题订正提交失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  if (error && !current) return <Message description={error} onBack={() => router.push(STUDENT_ROUTES.wrongQuestions)} />;
  if (!attempt || !current || !currentQuestion) return <Message description="正在加载错题和原题练习界面..." />;
  const editableSlotIds = current.practice.item.module === "ctw"
    ? readingWrongbookEditableSlotIds(current.targets)
    : undefined;
  return (
    <div className="min-h-[100dvh] bg-[#fbfbfe] text-student-text">
      <header className="grid h-[76px] grid-cols-[1fr_auto_1fr] items-center border-b border-student-border bg-white px-5">
        <button className="writing-header-back justify-self-start" onClick={() => router.push(STUDENT_ROUTES.wrongQuestions)} type="button">
          <ArrowLeft aria-hidden="true" size={20} /> Back
        </button>
        <p className="max-w-[50vw] truncate text-sm font-bold text-student-primary">错题订正 · {title}</p>
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
