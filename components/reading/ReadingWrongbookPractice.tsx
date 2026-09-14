"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  studentWrongQuestionsCacheKey,
  useStudentCachedData,
  useStudentDataCache,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { ReadingPracticeShell } from "@/components/reading/ReadingPractice";
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
  const [practice, setPractice] = useState<StudentReadingPracticePayload | null>(null);
  const [attempt, setAttempt] = useState<ReadingAttemptSummary | null>(null);
  const [initialAnswers, setInitialAnswers] = useState(() => ({}));
  const [currentItem, setCurrentItem] = useState<ReadingWrongbookQueueItem | null>(null);
  const queuedItem = queue.data?.items[index] ?? null;
  const current = currentItem ?? queuedItem;
  const logicalItemId = itemId ?? queuedItem?.logicalItemId ?? "";
  const detailKey = studentWrongQuestionsCacheKey(
    `reading-correction-detail:${scope}:${taskType}:${logicalItemId}:${todayRange.start}`
  );
  const detail = useStudentCachedData<Awaited<ReturnType<typeof loadCorrectionDetail>>>(
    detailKey,
    (session) => loadCorrectionDetail({
      logicalItemId,
      queuedItem,
      scope,
      session,
      taskType,
      todayEnd: todayRange.end,
      todayStart: todayRange.start
    }),
    { enabled: Boolean(logicalItemId) }
  );

  useEffect(() => {
    if (!detail.data) return;
    setPractice(detail.data.practice);
    setAttempt(detail.data.attempt);
    setCurrentItem(detail.data.item);
    setInitialAnswers(detail.data.initialAnswers);
  }, [detail.data]);

  if (queue.loading || detail.loading || ((itemId || current) && (!practice || !attempt) && !detail.error)) {
    return <WrongbookMessage description="正在加载错题和原题练习界面..." title="正在准备错题订正" />;
  }
  if (queue.error || detail.error) {
    return (
      <WrongbookMessage
        actionLabel="返回错题集"
        description={detail.error || queue.error || "错题订正加载失败，请稍后重试。"}
        onAction={() => router.push(STUDENT_ROUTES.wrongQuestions)}
        title="无法进入错题订正"
      />
    );
  }
  if (!current || !practice || !attempt) {
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
      attempt={attempt}
      initialAnswers={initialAnswers}
      onBack={() => router.push(STUDENT_ROUTES.wrongQuestions)}
      onExit={() => router.push(STUDENT_ROUTES.wrongQuestions)}
      practice={practice}
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

async function loadCorrectionDetail(input: {
  logicalItemId: string;
  queuedItem: ReadingWrongbookQueueItem | null;
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
  const [practiceResponse, attemptResponse] = await Promise.all([
    fetch(`/api/reading/practice/${encodeURIComponent(input.logicalItemId)}`, {
      cache: "no-store",
      headers
    }),
    fetch("/api/reading/wrongbook-attempts", {
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
    })
  ]);
  const practicePayload = await practiceResponse.json().catch(() => ({})) as PracticeResponse;
  if (!practiceResponse.ok || !practicePayload.practice) {
    throw new Error(practicePayload.error ?? "阅读错题内容加载失败，请稍后重试。");
  }
  const attemptPayload = await attemptResponse.json().catch(() => ({})) as AttemptResponse;
  if (!attemptResponse.ok || !isReadingWrongbookAttemptSummary(attemptPayload.attempt)) {
    throw new Error(attemptPayload.error ?? "错题订正记录加载失败，请稍后重试。");
  }
  if (
    attemptPayload.attempt.logicalItemId !== input.logicalItemId
    || attemptPayload.attempt.taskType !== input.taskType
  ) throw new Error("错题订正记录与当前题目不一致。");
  const item = attemptPayload.item ?? input.queuedItem;
  if (!item) throw new Error("错题订正记录返回了无效数据。");
  const practice = selectReadingWrongbookPractice(practicePayload.practice, item.targets);
  return {
    attempt: attemptPayload.attempt,
    initialAnswers: buildReadingWrongbookInitialAnswers(
      practice,
      attemptPayload.preservedAnswers ?? []
    ),
    item,
    practice
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
