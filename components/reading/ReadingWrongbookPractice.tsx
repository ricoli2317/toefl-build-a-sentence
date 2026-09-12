"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
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
    { refreshOnMount: true }
  );
  const [index] = useState(0);
  const [practice, setPractice] = useState<StudentReadingPracticePayload | null>(null);
  const [attempt, setAttempt] = useState<ReadingAttemptSummary | null>(null);
  const [initialAnswers, setInitialAnswers] = useState(() => ({}));
  const [loadError, setLoadError] = useState("");
  const current = queue.data?.items[index] ?? null;

  useEffect(() => {
    if (!current) return;
    const queueItem = current;
    let cancelled = false;
    setPractice(null);
    setAttempt(null);
    setInitialAnswers({});
    setLoadError("");
    async function load() {
      try {
        const { data: { session } } = await createBrowserSupabase().auth.getSession();
        if (!session) throw new Error("请先登录后再开始错题订正。");
        const headers = {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json"
        };
        const practiceResponse = await fetch(
          `/api/reading/practice/${encodeURIComponent(queueItem.logicalItemId)}`,
          { cache: "no-store", headers }
        );
        const practicePayload = await practiceResponse.json().catch(() => ({})) as PracticeResponse;
        if (!practiceResponse.ok || !practicePayload.practice) {
          throw new Error(practicePayload.error ?? "阅读错题内容加载失败，请稍后重试。");
        }
        const attemptResponse = await fetch("/api/reading/wrongbook-attempts", {
          method: "POST",
          cache: "no-store",
          headers,
          body: JSON.stringify({
            itemId: queueItem.logicalItemId,
            scope,
            taskType,
            todayEnd: todayRange.end,
            todayStart: todayRange.start
          })
        });
        const attemptPayload = await attemptResponse.json().catch(() => ({})) as AttemptResponse;
        if (!attemptResponse.ok || !isReadingWrongbookAttemptSummary(attemptPayload.attempt)) {
          throw new Error(attemptPayload.error ?? "错题订正记录加载失败，请稍后重试。");
        }
        if (
          attemptPayload.attempt.logicalItemId !== queueItem.logicalItemId
          || attemptPayload.attempt.taskType !== taskType
        ) throw new Error("错题订正记录与当前题目不一致。");
        if (!cancelled) {
          const selectedPractice = selectReadingWrongbookPractice(practicePayload.practice, queueItem.targets);
          setPractice(selectedPractice);
          setAttempt(attemptPayload.attempt);
          setInitialAnswers(buildReadingWrongbookInitialAnswers(
            selectedPractice,
            attemptPayload.preservedAnswers ?? []
          ));
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "错题订正加载失败，请稍后重试。");
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [current, scope, taskType, todayRange.end, todayRange.start]);

  if (queue.loading || (current && (!practice || !attempt) && !loadError)) {
    return <WrongbookMessage description="正在加载错题和原题练习界面..." title="正在准备错题订正" />;
  }
  if (queue.error || loadError) {
    return (
      <WrongbookMessage
        actionLabel="返回错题集"
        description={loadError || queue.error || "错题订正加载失败，请稍后重试。"}
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
      reviewTitle={`错题订正 · ${current.title} · ${index + 1}/${queue.data!.items.length}`}
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
