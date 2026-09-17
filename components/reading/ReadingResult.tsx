"use client";

import { useEffect, useRef, useState } from "react";
import {
  studentReadingResultCacheKey,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  formatScoreComparison,
  formatTimeComparison,
  PracticeResultSummary,
  RESULT_COMPARISON_LOADING_TEXT
} from "@/components/PracticeResult";
import {
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type {
  ReadingResultAnswer,
  ReadingResultPayload
} from "@/lib/reading/history";
import {
  EMPTY_RESULT_PEER_COMPARISON,
  type ResultPeerComparison
} from "@/lib/resultPeerComparison";
import {
  getReadingResultNavigation,
  readingResultHref,
  withReadingResultSource,
  type ReadingResultSource
} from "@/lib/studentNavigation";
import { ReadingRetakeButton } from "./ReadingRetakeButton";
import { ReadingQuestionStatusChips } from "./ReadingQuestionStatusChips";

export function ReadingResult({
  attemptId,
  source
}: {
  attemptId: string;
  source?: ReadingResultSource;
}) {
  const state = useStudentCachedData<ReadingResultPayload>(
    studentReadingResultCacheKey(attemptId),
    (session) => loadReadingResult(attemptId, session)
  );
  const [peerComparison, setPeerComparison] = useState<ResultPeerComparison | null>(null);
  const peerRequestAttemptRef = useRef<string | null>(null);

  useEffect(() => {
    if (!state.data?.attempt || peerRequestAttemptRef.current === attemptId) return;
    peerRequestAttemptRef.current = attemptId;
    let cancelled = false;
    void loadReadingPeerComparison(attemptId).then(
      (comparison) => {
        if (!cancelled) setPeerComparison(comparison);
      },
      () => {
        if (!cancelled) setPeerComparison(EMPTY_RESULT_PEER_COMPARISON);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [attemptId, state.data?.attempt]);

  if (state.loading) return <StudentLoadingState text="正在加载阅读结果..." />;
  if (state.error || !state.data) return <StudentErrorState text="没有找到阅读结果或加载失败。" />;

  const { answers, attempt } = state.data;
  const scoreComparison = peerComparison
    ? formatScoreComparison(peerComparison)
    : RESULT_COMPARISON_LOADING_TEXT;
  const timeComparison = peerComparison
    ? formatTimeComparison(peerComparison)
    : RESULT_COMPARISON_LOADING_TEXT;
  const navigation = getReadingResultNavigation(attempt.taskType, source);

  return (
    <div className="student-result-overview-layout">
      <div className="student-result-overview-navigation">
        <StudentNavigation
          backHref={navigation.backHref}
          crumbs={navigation.crumbs}
        />
      </div>
      <PracticeResultSummary
        correctPoints={attempt.correctPoints}
        elapsedSeconds={attempt.elapsedSeconds}
        scoreComparison={scoreComparison}
        timeComparison={timeComparison}
        title="练习结果"
        totalPoints={attempt.totalPoints}
      />
      <ReadingDetailCard
        answers={answers}
        attemptId={attempt.attemptId}
        source={source}
        submittedAt={attempt.submittedAt}
      />
    </div>
  );
}

function ReadingDetailCard({
  answers,
  attemptId,
  source,
  submittedAt,
}: {
  answers: ReadingResultAnswer[];
  attemptId: string;
  source?: ReadingResultSource;
  submittedAt: string;
}) {
  return (
    <section className="student-card" data-testid="reading-result-detail">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-student-text">作答详情</h2>
          <p className="mt-1 text-sm text-student-muted">提交于 {formatDateTime(submittedAt)}</p>
        </div>
        <ReadingRetakeButton attemptId={attemptId} />
      </div>
      <ReadingQuestionStatusChips
        answers={answers}
        questionHref={(reviewIndex) => withReadingResultSource(
          `${readingResultHref(attemptId)}/questions/${reviewIndex}`,
          source
        )}
        questionHrefBase={`/student/reading/results/${encodeURIComponent(attemptId)}`}
      />
    </section>
  );
}

async function loadReadingResult(attemptId: string, session: StudentCacheSession) {
  const response = await fetch(`/api/reading/results/${encodeURIComponent(attemptId)}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as ReadingResultPayload & { error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? "阅读结果加载失败。");
  return payload;
}

async function loadReadingPeerComparison(attemptId: string) {
  const { data: { session } } = await createBrowserSupabase().auth.getSession();
  const response = await fetch(
    `/api/reading/results/${encodeURIComponent(attemptId)}/peer-comparison`,
    {
      cache: "no-store",
      headers: { Authorization: `Bearer ${session?.access_token ?? ""}` }
    }
  );
  const payload = await response.json().catch(() => ({})) as {
    error?: string;
    peer_comparison?: ResultPeerComparison;
  };
  if (!response.ok || payload.error || !payload.peer_comparison) {
    throw new Error(payload.error ?? "同班比较加载失败。");
  }
  return payload.peer_comparison;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
