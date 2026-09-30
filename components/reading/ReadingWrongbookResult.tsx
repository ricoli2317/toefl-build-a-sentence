"use client";

import {
  studentReadingResultCacheKey,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { PracticeResultSummary } from "@/components/PracticeResult";
import { StudentErrorState, StudentLoadingState, StudentNavigation } from "@/components/student/StudentUI";
import type {
  ReadingCorrectionResultPayload
} from "@/lib/reading/correctionResult";
import { STUDENT_ROUTES, withStudentReturnTo } from "@/lib/studentNavigation";
import { ReadingCorrectionEntryButton } from "./ReadingCorrectionEntryButton";
import { ReadingQuestionStatusChips } from "./ReadingQuestionStatusChips";

export function ReadingWrongbookResult({
  attemptId,
  returnTo
}: {
  attemptId: string;
  returnTo?: string | null;
}) {
  const state = useStudentCachedData<ReadingCorrectionResultPayload>(
    studentReadingResultCacheKey(`wrongbook:${attemptId}`),
    (session) => loadResult(attemptId, session)
  );
  if (state.loading) return <StudentLoadingState text="正在加载订正结果..." />;
  if (state.error || !state.data) return <StudentErrorState text="没有找到订正结果或加载失败。" />;

  const { answers, attempt } = state.data;
  const questionHrefBase = `/student/reading/wrongbook-results/${encodeURIComponent(attemptId)}`;
  const backHref = returnTo?.trim() || STUDENT_ROUTES.wrongQuestions;
  return (
    <div className="student-result-overview-layout">
      <div className="student-result-overview-navigation">
        <StudentNavigation
          backHref={backHref}
          crumbs={[
            { label: "学生首页", href: STUDENT_ROUTES.home },
            { label: "错题集", href: STUDENT_ROUTES.wrongQuestions },
            { label: "订正结果" }
          ]}
        />
      </div>
      <PracticeResultSummary
        correctPoints={attempt.correctPoints}
        elapsedSeconds={attempt.elapsedSeconds}
        scoreComparison={null}
        timeComparison={null}
        title="订正结果"
        totalPoints={attempt.totalPoints}
      />
      <section className="student-card" data-testid="reading-wrongbook-result-detail">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-student-text">作答详情</h2>
            <p className="mt-1 text-sm text-student-muted">提交于 {formatDateTime(attempt.submittedAt)}</p>
          </div>
          {String(attempt.taskType) !== "full_set"
            && answers.some((answer) => !answer.isAnswered || !answer.isCorrect) ? (
            <ReadingCorrectionEntryButton attemptId={attemptId} taskType={attempt.taskType} />
          ) : null}
        </div>
        <ReadingQuestionStatusChips
          answers={answers}
          questionHref={(reviewIndex) =>
            withStudentReturnTo(`${questionHrefBase}/questions/${reviewIndex}`, returnTo)}
          questionHrefBase={questionHrefBase}
        />
      </section>
    </div>
  );
}

async function loadResult(attemptId: string, session: StudentCacheSession) {
  const response = await fetch(
    `/api/reading/wrongbook-attempts/${encodeURIComponent(attemptId)}/result`,
    { cache: "no-store", headers: { Authorization: `Bearer ${session.accessToken}` } }
  );
  const payload = await response.json().catch(() => ({})) as ReadingCorrectionResultPayload & { error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? "订正结果加载失败。");
  return payload;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
