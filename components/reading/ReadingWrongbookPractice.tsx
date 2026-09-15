"use client";

import { useMemo, useState } from "react";
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
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import type { ReadingAttemptSummary } from "@/lib/reading/attempts";
import type { StudentReadingPracticePayload } from "@/lib/reading/studentPractice";
import type { ReadingModule } from "@/lib/reading/types";
import type { ReadingWrongbookQueueItem } from "@/lib/wrongQuestions";
import {
  buildReadingWrongbookInitialAnswers,
  isReadingWrongbookAttemptSummary,
  isReadingWrongbookQueuePayload,
  selectReadingWrongbookPractice,
  type ReadingWrongbookQueuePayload,
  type ReadingWrongbookPreservedAnswer,
  type ReadingWrongbookScope
} from "@/lib/reading/wrongbook";

type PracticeResponse = { error?: string; practice?: StudentReadingPracticePayload };
type AttemptResponse = {
  attempt?: ReadingAttemptSummary;
  error?: string;
  item?: ReadingWrongbookQueueItem;
  preservedAnswers?: ReadingWrongbookPreservedAnswer[];
};

export function ReadingWrongbookPractice({
  itemId,
  scope,
  taskType
}: {
  itemId?: string;
  scope: ReadingWrongbookScope;
  taskType: ReadingModule;
}) {
  const router = useRouter();
  const cache = useStudentDataCache();
  const [todayRange] = useState(localDayRange);
  const query = useMemo(() => {
    const params = new URLSearchParams({
      scope,
      taskType,
      todayEnd: todayRange.end,
      todayStart: todayRange.start
    });
    if (itemId) params.set("itemId", itemId);
    return params.toString();
  }, [itemId, scope, taskType, todayRange.end, todayRange.start]);
  const queueKey = studentWrongQuestionsCacheKey(`reading-correction:${query}`);
  const queue = useStudentCachedData<ReadingWrongbookQueuePayload>(
    queueKey,
    (session) => loadQueue(query, session),
    { enabled: !itemId }
  );
  const [index] = useState(0);
  const queuedItem = queue.data?.items[index] ?? null;
  const logicalItemId = itemId ?? queuedItem?.logicalItemId ?? "";
  const practiceKey = studentWrongQuestionsCacheKey(
    `reading-correction-practice:${logicalItemId}`
  );
  const correctionKey = studentWrongQuestionsCacheKey(
    `reading-correction-attempt:${scope}:${taskType}:${logicalItemId}:${todayRange.start}`
  );
  const practiceRequest = useStudentCachedData<StudentReadingPracticePayload>(
    practiceKey,
    (session) => loadPractice(logicalItemId, session),
    { enabled: Boolean(logicalItemId) }
  );
  const correctionRequest = useStudentCachedData<Awaited<ReturnType<typeof loadCorrectionAttempt>>>(
    correctionKey,
    (session) => loadCorrectionAttempt({
      logicalItemId,
      scope,
      session,
      taskType,
      todayEnd: todayRange.end,
      todayStart: todayRange.start
    }),
    { enabled: Boolean(logicalItemId) }
  );
  const requestError = practiceRequest.error || correctionRequest.error;
  const current = correctionRequest.data?.item ?? queuedItem;
  const ready = useMemo(() => {
    if (!practiceRequest.data || !correctionRequest.data || !current) return null;
    const { attempt, preservedAnswers } = correctionRequest.data;
    if (
      attempt.logicalItemId !== logicalItemId
      || attempt.taskType !== taskType
      || current.logicalItemId !== logicalItemId
    ) return { error: "错题订正记录与当前题目不一致。" } as const;
    const practice = selectReadingWrongbookPractice(practiceRequest.data, current.targets);
    return {
      attempt,
      initialAnswers: buildReadingWrongbookInitialAnswers(practice, preservedAnswers),
      practice
    };
  }, [correctionRequest.data, current, logicalItemId, practiceRequest.data, taskType]);
  const previewPractice = useMemo(() => {
    const raw = practiceRequest.data;
    if (!raw || correctionRequest.data) return null;
    if (queuedItem?.logicalItemId === logicalItemId) {
      return selectReadingWrongbookPractice(raw, queuedItem.targets);
    }
    return taskType === "ctw" && raw.questions.length === 1 ? raw : null;
  }, [correctionRequest.data, logicalItemId, practiceRequest.data, queuedItem, taskType]);

  if (queue.error || requestError || ready?.error) {
    return (
      <WrongbookMessage
        actionLabel="返回错题集"
        description={ready?.error || requestError || queue.error || "错题订正加载失败，请稍后重试。"}
        onAction={() => router.push(STUDENT_ROUTES.wrongQuestions)}
        title="无法进入错题订正"
      />
    );
  }
  if (previewPractice && correctionRequest.loading) {
    return (
      <ReadingPracticePendingShell
        onBack={() => router.push(STUDENT_ROUTES.wrongQuestions)}
        practice={previewPractice}
        reviewTitle={`错题订正 · ${queuedItem?.title ?? previewPractice.item.title}`}
      />
    );
  }
  if (queue.loading || practiceRequest.loading || correctionRequest.loading) {
    return <WrongbookMessage description="正在加载错题和原题练习界面..." title="正在准备错题订正" />;
  }
  if (!current || !ready || "error" in ready) {
    return (
      <WrongbookMessage
        actionLabel="返回错题集"
        description="当前范围内没有待订正错题。"
        onAction={() => router.push(STUDENT_ROUTES.wrongQuestions)}
        title="暂无待订正错题"
      />
    );
  }

  return (
    <ReadingPracticeShell
      attempt={ready.attempt}
      initialAnswers={ready.initialAnswers}
      onBack={() => router.push(STUDENT_ROUTES.wrongQuestions)}
      practice={ready.practice}
      reviewTitle={`错题订正 · ${current.title} · ${index + 1}/${queue.data?.items.length ?? 1}`}
      wrongbook={{
        targets: current.targets,
        onSubmitted: (submittedAttempt) => {
          cache.invalidate(queueKey);
          router.replace(`/student/reading/wrongbook-results/${encodeURIComponent(submittedAttempt.attemptId)}`);
        }
      }}
    />
  );
}

async function loadQueue(query: string, session: StudentCacheSession) {
  const response = await fetch(`/api/reading/wrongbook-attempts?${query}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as ReadingWrongbookQueuePayload & { error?: string };
  if (!response.ok || payload.error || !isReadingWrongbookQueuePayload(payload)) {
    throw new Error(payload.error ?? "错题订正加载失败，请稍后重试。");
  }
  return payload;
}

async function loadPractice(logicalItemId: string, session: StudentCacheSession) {
  const response = await fetch(`/api/reading/practice/${encodeURIComponent(logicalItemId)}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as PracticeResponse;
  if (!response.ok || !payload.practice) {
    throw new Error(payload.error ?? "阅读错题内容加载失败，请稍后重试。");
  }
  if (payload.practice.item.itemId !== logicalItemId) {
    throw new Error("阅读错题内容与当前题目不一致。");
  }
  return payload.practice;
}

async function loadCorrectionAttempt(input: {
  logicalItemId: string;
  scope: ReadingWrongbookScope;
  session: StudentCacheSession;
  taskType: ReadingModule;
  todayEnd: string;
  todayStart: string;
}) {
  const headers = {
    Authorization: `Bearer ${input.session.accessToken}`,
    "Content-Type": "application/json"
  };
  const attemptResponse = await fetch("/api/reading/wrongbook-attempts", {
    method: "POST",
    cache: "no-store",
    headers,
    body: JSON.stringify({
      itemId: input.logicalItemId,
      scope: input.scope,
      taskType: input.taskType,
      todayEnd: input.todayEnd,
      todayStart: input.todayStart
    })
  });
  const attemptPayload = await attemptResponse.json().catch(() => ({})) as AttemptResponse;
  if (!attemptResponse.ok || !isReadingWrongbookAttemptSummary(attemptPayload.attempt)) {
    throw new Error(attemptPayload.error ?? "错题订正记录加载失败，请稍后重试。");
  }
  return {
    attempt: attemptPayload.attempt,
    item: attemptPayload.item,
    preservedAnswers: attemptPayload.preservedAnswers ?? []
  };
}

function WrongbookMessage({
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
    <main className="flex min-h-screen items-center justify-center bg-[#fbfbfe] px-5">
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

function localDayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { end: end.toISOString(), start: start.toISOString() };
}
