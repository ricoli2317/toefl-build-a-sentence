"use client";

import {
  studentReadingFullSetResultCacheKey,
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
  buildReadingFullSetReviewItems,
  readingFullSetReviewTotalTime
} from "@/lib/reading/fullSetReview";
import {
  getReadingFullSetResultNavigation,
  readingFullSetResultHref,
  withReadingResultSource,
  type ReadingResultSource
} from "@/lib/studentNavigation";
import { ReadingFullSetQuestionNavigator } from "./ReadingFullSetQuestionNavigator";
import { ReadingFullSetRetakeButton } from "./ReadingFullSetRetakeButton";

export function ReadingFullSetResult({
  attemptId,
  fullSetId,
  source
}: {
  attemptId: string;
  fullSetId: string;
  source?: ReadingResultSource;
}) {
  const state = useStudentCachedData<ReadingFullSetResultPayload>(
    studentReadingFullSetResultCacheKey(attemptId),
    (session) => loadResult(fullSetId, attemptId, session)
  );
  if (state.loading) return <StudentLoadingState text="正在加载套题结果..." />;
  if (state.error || !state.data) return <StudentErrorState text="没有找到套题结果或加载失败。" />;
  const result = state.data;
  const correctPoints = result.answers.filter((answer) => answer.isCorrect).length;
  const questionHrefBase = readingFullSetResultHref(fullSetId, attemptId);
  const reviewItems = buildReadingFullSetReviewItems(
    result.answers,
    (answerIndex) => withReadingResultSource(
      `${questionHrefBase}/questions/${answerIndex}`,
      source
    )
  );
  const navigation = getReadingFullSetResultNavigation(result.attempt.title, source);
  return (
    <div className="student-result-overview-layout">
      <div className="student-result-overview-navigation">
        <StudentNavigation
          backHref={navigation.backHref}
          crumbs={navigation.crumbs}
        />
      </div>
      <PracticeResultSummary
        correctPoints={correctPoints}
        elapsedSeconds={readingFullSetReviewTotalTime(result.answers)}
        scoreComparison={null}
        scoreValue={result.score.display}
        timeComparison={null}
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
        <div className="mt-6">
          <ReadingFullSetQuestionNavigator items={reviewItems} />
        </div>
      </section>
    </div>
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

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
