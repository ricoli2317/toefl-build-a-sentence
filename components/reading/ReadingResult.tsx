"use client";

import Link from "next/link";
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
  ReadingResultCtwParagraph,
  ReadingResultPayload
} from "@/lib/reading/history";
import {
  EMPTY_RESULT_PEER_COMPARISON,
  type ResultPeerComparison
} from "@/lib/resultPeerComparison";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { ReadingRetakeButton } from "./ReadingRetakeButton";

export function ReadingResult({ attemptId }: { attemptId: string }) {
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

  const { answers, attempt, ctwParagraphs } = state.data;
  const scoreComparison = peerComparison
    ? formatScoreComparison(peerComparison)
    : RESULT_COMPARISON_LOADING_TEXT;
  const timeComparison = peerComparison
    ? formatTimeComparison(peerComparison)
    : RESULT_COMPARISON_LOADING_TEXT;

  return (
    <div className="grid gap-6">
      <StudentNavigation
        backHref={STUDENT_ROUTES.practiceHistory}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: "练习历史", href: STUDENT_ROUTES.practiceHistory },
          { label: "查看结果" }
        ]}
      />
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
        ctwParagraphs={ctwParagraphs}
        submittedAt={attempt.submittedAt}
        taskType={attempt.taskType}
      />
    </div>
  );
}

function ReadingDetailCard({
  answers,
  attemptId,
  ctwParagraphs,
  submittedAt,
  taskType
}: {
  answers: ReadingResultAnswer[];
  attemptId: string;
  ctwParagraphs: ReadingResultCtwParagraph[];
  submittedAt: string;
  taskType: ReadingResultPayload["attempt"]["taskType"];
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
      {taskType === "ctw" ? (
        <CtwParagraphResult paragraphs={ctwParagraphs} />
      ) : (
        <ReadingQuestionStatusChips answers={answers} attemptId={attemptId} />
      )}
    </section>
  );
}

function CtwParagraphResult({ paragraphs }: { paragraphs: ReadingResultCtwParagraph[] }) {
  return (
    <article
      className="mt-6 text-sm leading-6 text-student-text"
      data-testid="ctw-result-passage"
    >
      {paragraphs.map((paragraph) => (
        <p className="mb-4 last:mb-0" key={paragraph.paragraphId}>
          {paragraph.segments.map((segment, index) => {
            if (segment.kind === "text") {
              return <span key={`${paragraph.paragraphId}:text:${index}`}>{segment.text}</span>;
            }
            return (
              <span className="whitespace-nowrap" data-ctw-result-slot={segment.order} key={segment.answerId}>
                <span>{segment.prefix}</span>
                <span
                  className={segment.isAnswered
                    ? segment.isCorrect ? "font-semibold text-student-primary" : "font-semibold text-student-error"
                    : "font-semibold text-student-muted"}
                  data-answer-state={segment.isAnswered ? segment.isCorrect ? "correct" : "incorrect" : "unanswered"}
                >
                  {segment.studentAnswer || "____"}
                </span>
              </span>
            );
          })}
        </p>
      ))}
    </article>
  );
}

export function ReadingQuestionStatusChips({
  answers,
  attemptId
}: {
  answers: ReadingResultAnswer[];
  attemptId: string;
}) {
  return (
    <div className="mt-6 flex flex-wrap justify-center gap-3" data-testid="reading-result-question-chips">
      {answers.map((answer, questionIndex) => {
        const state = !answer.isAnswered ? "unanswered" : answer.isCorrect ? "correct" : "incorrect";
        const className = state === "correct"
          ? "border-student-primary-border bg-student-primary-soft text-student-primary"
          : state === "incorrect"
            ? "border-student-error-border bg-student-error-soft text-student-error"
            : "border-student-border bg-student-bg text-student-muted";
        return (
          <Link
            className={`inline-flex min-h-10 items-center rounded-full border px-4 py-2 text-sm font-semibold tabular-nums ${className}`}
            data-answer-state={state}
            href={`/student/reading/results/${encodeURIComponent(attemptId)}/questions/${questionIndex}`}
            key={answer.answerId}
          >
            第{answer.order}题 · {formatQuestionTime(answer.questionTimeSeconds)}
          </Link>
        );
      })}
    </div>
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

function formatQuestionTime(seconds: number | null) {
  if (seconds === null) return "时间暂无记录";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
