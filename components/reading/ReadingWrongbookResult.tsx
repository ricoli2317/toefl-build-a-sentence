"use client";

import {
  studentReadingResultCacheKey,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { PracticeResultSummary } from "@/components/PracticeResult";
import { StudentErrorState, StudentLoadingState, StudentNavigation } from "@/components/student/StudentUI";
import type { ReadingResultPayload } from "@/lib/reading/history";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { ReadingQuestionStatusChips } from "./ReadingResult";

export function ReadingWrongbookResult({ attemptId }: { attemptId: string }) {
  const state = useStudentCachedData<ReadingResultPayload>(
    studentReadingResultCacheKey(`wrongbook:${attemptId}`),
    (session) => loadResult(attemptId, session)
  );
  if (state.loading) return <StudentLoadingState text="正在加载订正结果..." />;
  if (state.error || !state.data) return <StudentErrorState text="没有找到订正结果或加载失败。" />;

  const { answers, attempt } = state.data;
  const questionHrefBase = `/student/reading/wrongbook-results/${encodeURIComponent(attemptId)}`;
  return (
    <div className="grid gap-6">
      <StudentNavigation
        backHref={STUDENT_ROUTES.wrongQuestions}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: "错题集", href: STUDENT_ROUTES.wrongQuestions },
          { label: "订正结果" }
        ]}
      />
      <PracticeResultSummary
        correctPoints={attempt.correctPoints}
        elapsedSeconds={attempt.elapsedSeconds}
        scoreComparison="本次订正按待订正题计分"
        timeComparison="订正用时不参与班级比较"
        title="订正结果"
        totalPoints={attempt.totalPoints}
      />
      <section className="student-card" data-testid="reading-wrongbook-result-detail">
        <div>
          <h2 className="text-xl font-bold text-student-text">本次订正作答</h2>
          <p className="mt-1 text-sm text-student-muted">选择题号查看作答、正误和 Correct Answer。</p>
        </div>
        <ReadingQuestionStatusChips
          answers={answers}
          attemptId={attemptId}
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
  const payload = await response.json().catch(() => ({})) as ReadingResultPayload & { error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? "订正结果加载失败。");
  return payload;
}
