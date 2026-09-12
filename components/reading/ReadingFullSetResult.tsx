"use client";

import Link from "next/link";
import {
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { PracticeResultSummary } from "@/components/PracticeResult";
import {
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import type { ReadingFullSetResultPayload } from "@/lib/reading/fullSetResults";
import {
  aggregateCtwInteractionTime,
  readingFullSetReviewTotalTime
} from "@/lib/reading/fullSetReview";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { ReadingFullSetRetakeButton } from "./ReadingFullSetRetakeButton";

export function ReadingFullSetResult({
  attemptId,
  fullSetId
}: {
  attemptId: string;
  fullSetId: string;
}) {
  const state = useStudentCachedData<ReadingFullSetResultPayload>(
    `reading:full-sets:result:${attemptId}`,
    (session) => loadResult(fullSetId, attemptId, session)
  );
  if (state.loading) return <StudentLoadingState text="正在加载套题结果..." />;
  if (state.error || !state.data) return <StudentErrorState text="没有找到套题结果或加载失败。" />;
  const result = state.data;
  const correctPoints = result.answers.filter((answer) => answer.isCorrect).length;
  const ctwTimeByOccurrence = new Map<string, number | null>(result.answers
    .filter((answer) => answer.taskType === "ctw")
    .map((answer) => answer.occurrenceId)
    .filter((occurrenceId, index, occurrenceIds) => occurrenceIds.indexOf(occurrenceId) === index)
    .map((occurrenceId) => [
      occurrenceId,
      aggregateCtwInteractionTime(result.answers.filter((answer) => answer.occurrenceId === occurrenceId))
    ] as const));
  return (
    <div className="grid gap-6">
      <StudentNavigation
        backHref={STUDENT_ROUTES.practiceHistory}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: "练习历史", href: STUDENT_ROUTES.practiceHistory },
          { label: result.attempt.title }
        ]}
      />
      <PracticeResultSummary
        correctPoints={correctPoints}
        elapsedSeconds={readingFullSetReviewTotalTime(result.answers)}
        scoreValue={result.score.display}
        title={result.attempt.title}
        totalPoints={result.answers.length}
      />
      <section className="student-card" data-testid="full-set-result-detail">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-student-text">作答详情</h2>
            <p className="mt-1 text-sm text-student-muted">提交于 {formatDateTime(result.attempt.completedAt)}</p>
          </div>
          <ReadingFullSetRetakeButton fullSetId={fullSetId} />
        </div>
        <div className="mt-6 grid gap-7">
          {result.modules.map((module) => (
            <section key={module.moduleNumber}>
              <h3 className="border-l-4 border-student-primary pl-3 text-lg font-bold text-student-text">
                Module {module.moduleNumber}
              </h3>
              <div className="mt-4 grid gap-5">
                {module.sections.map((section) => (
                  <div key={section.taskType}>
                    <h4 className="text-sm font-bold text-student-text">{section.taskName}</h4>
                    <div className="mt-2 flex flex-wrap gap-3">
                      {section.answers.map((answer) => (
                        <ResultChip
                          answer={answer}
                          attemptId={attemptId}
                          fullSetId={fullSetId}
                          key={answer.answerId}
                          questionTimeSeconds={answer.taskType === "ctw"
                            ? ctwTimeByOccurrence.get(answer.occurrenceId) ?? null
                            : answer.questionTimeSeconds}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}

function ResultChip({
  answer,
  attemptId,
  fullSetId,
  questionTimeSeconds
}: {
  answer: ReadingFullSetResultPayload["answers"][number];
  attemptId: string;
  fullSetId: string;
  questionTimeSeconds: number | null;
}) {
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
      href={`${STUDENT_ROUTES.readingFullSets}/${encodeURIComponent(fullSetId)}/result/${encodeURIComponent(attemptId)}/questions/${answer.index}`}
    >
      第{answer.order}题 · {formatQuestionTime(questionTimeSeconds)}
    </Link>
  );
}

async function loadResult(fullSetId: string, attemptId: string, session: StudentCacheSession) {
  const response = await fetch(
    `/api/reading/full-sets/${encodeURIComponent(fullSetId)}/results/${encodeURIComponent(attemptId)}`,
    { cache: "no-store", headers: { Authorization: `Bearer ${session.accessToken}` } }
  );
  const payload = await response.json().catch(() => ({})) as ReadingFullSetResultPayload & { error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? "套题结果加载失败。");
  return payload;
}

function formatQuestionTime(seconds: number | null) {
  if (seconds === null) return "—";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
