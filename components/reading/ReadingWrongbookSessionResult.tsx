"use client";

import Link from "next/link";
import { useRef } from "react";
import {
  studentWrongQuestionsCacheKey,
  useStudentCachedData,
  useStudentDataCache,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { PracticeResultSummary } from "@/components/PracticeResult";
import { StudentErrorState, StudentLoadingState, StudentNavigation } from "@/components/student/StudentUI";
import { loadWrongbookCompletedReview, sessionReviewBundleCacheKey } from "@/lib/reading/sessionReviewBundle";
import {
  mergeReadingWrongbookSessionResults,
  readingWrongbookSessionResumeHref,
} from "@/lib/reading/wrongbookSession";
import { nextWrongQuestionHistoryAmount } from "@/lib/wrongQuestionBank";
import { STUDENT_ROUTES, withStudentReturnTo } from "@/lib/studentNavigation";
import type { WrongQuestionPracticeSession } from "@/lib/wrongQuestionBank";
import { ReadingResultDetailCard } from "./ReadingResult";

type SessionPayload = { error?: string; session?: WrongQuestionPracticeSession };

/**
 * History / today Reading wrong-question session result: the normal Reading
 * result structure (summary + "作答详情" + 1..N question chips) over the frozen
 * session's per-source results. No per-material sections, scores, or summary.
 */
export function ReadingWrongbookSessionResult({
  returnTo,
  sessionId
}: {
  returnTo?: string | null;
  sessionId: string;
}) {
  const state = useStudentCachedData<SessionPayload>(
    studentWrongQuestionsCacheKey(`reading-bank-result:${sessionId}`),
    (session) => loadSession(sessionId, session)
  );
  const cache = useStudentDataCache();
  // The cache context value changes on every notification, so effects that
  // write into it must not depend on the object identity.
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const session = state.data?.session ?? null;
  // Completed result is the authoritative hydration point. The same key and
  // loader also recover a direct review link; question clicks never load groups.
  const review = useStudentCachedData(sessionReviewBundleCacheKey("wrongbook", sessionId),
    (auth) => loadWrongbookCompletedReview(sessionId, cacheRef.current, auth, session ?? undefined),
    { enabled: session?.status === "completed" });

  if (state.loading) return <StudentLoadingState text="正在加载练习结果..." />;
  if (state.error) {
    console.error("Reading session result manifest failed", {
      sessionId,
      reason: state.error
    });
    return <StudentErrorState text="练习结果暂时无法加载，请稍后重试。" />;
  }
  if (state.data?.error) {
    return <StudentErrorState text={`没有找到练习结果：${state.data.error}`} />;
  }
  if (!session) return <StudentErrorState text="没有找到这次练习。" />;
  if (session.status !== "completed") {
    const missingProgress = (session.groups ?? []).some(
      (group) => !session.progress[group.logicalItemId]
    );
    if (missingProgress) {
      // Re-entering continues the SAME frozen session: the resume link pins the
      // session id, so the student never gets a different draw or a
      // single-material correction instead of the unfinished practice.
      return (
        <div className="reading-theme mx-auto grid w-full max-w-xl gap-4 py-8">
          <section className="student-card p-8 text-center">
            <h1 className="text-2xl font-bold text-student-text">这次练习还没有完成</h1>
            <p className="mt-3 text-sm leading-6 text-student-muted">
              继续完成本场练习后即可查看完整结果。
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Link
                className="student-button-primary"
                href={readingWrongbookSessionResumeHref({
                  amount: session.amount ?? null,
                  mode: session.mode,
                  returnTo,
                  sessionId,
                  taskType: session.taskType
                })}
              >
                继续练习
              </Link>
              <Link
                className="student-button-secondary"
                href={returnTo?.trim() || STUDENT_ROUTES.wrongQuestions}
              >
                返回错题集
              </Link>
            </div>
          </section>
        </div>
      );
    }
    console.warn("Reading session result loaded while the session status is not completed", {
      sessionId,
      status: session.status
    });
  }
  if (review.error) return <StudentErrorState text={review.error} />;
  if (!review.data) return <StudentLoadingState text="正在准备完整练习结果..." />;

  let merged;
  try {
    merged = mergeReadingWrongbookSessionResults(review.data.results);
  } catch (failure) {
    console.error("Reading session result aggregation failed", {
      sessionId,
      reason: failure instanceof Error ? failure.message : "unknown"
    });
    return <StudentErrorState text="练习结果数据暂时无法聚合，请稍后重试。" />;
  }
  const safeReturnTo = returnTo?.trim() || "";
  const selfBase = `/student/wrong-questions/sessions/${encodeURIComponent(sessionId)}`;
  const selfPath = withStudentReturnTo(selfBase, safeReturnTo);
  const title = session.mode === "today" ? "今日错题订正" : "历史错题练习";
  const retakeHref = session.mode === "history" && session.amount
    ? `/student/wrong-questions/history/reading/practice?${new URLSearchParams({
        amount: String(nextWrongQuestionHistoryAmount(session.amount)),
        mode: "history",
        returnTo: selfPath,
        taskType: session.taskType
      }).toString()}`
    : null;
  const submittedAt = review.data.results.at(-1)?.payload.attempt.submittedAt ?? session.createdAt;

  return (
    <div className="reading-theme student-result-overview-layout">
      <div className="student-result-overview-navigation">
        <StudentNavigation
          backHref={safeReturnTo || STUDENT_ROUTES.wrongQuestions}
          crumbs={[
            { label: "学生首页", href: STUDENT_ROUTES.home },
            { label: "错题集", href: STUDENT_ROUTES.wrongQuestions },
            { label: "练习结果" }
          ]}
        />
      </div>
      <PracticeResultSummary
        correctPoints={merged.correctPoints}
        elapsedSeconds={merged.elapsedSeconds}
        scoreComparison={null}
        timeComparison={null}
        title={title}
        totalPoints={merged.totalPoints}
      />
      <ReadingResultDetailCard
        actions={retakeHref ? (
          <Link className="student-button-primary" href={retakeHref}>
            重新练习
          </Link>
        ) : undefined}
        answers={merged.answers.map((answer) => ({
          answerId: answer.answerId,
          isAnswered: answer.isAnswered,
          isCorrect: answer.isCorrect,
          order: answer.globalOrder,
          reviewIndex: answer.reviewIndex
        }))}
        questionHref={(reviewIndex) =>
          withStudentReturnTo(`${selfBase}/questions/${reviewIndex}`, safeReturnTo)}
        questionHrefBase={selfBase}
        submittedAt={submittedAt}
      />
    </div>
  );
}

async function loadSession(sessionId: string, session: StudentCacheSession) {
  const response = await fetch(
    `/api/wrong-questions/sessions/${encodeURIComponent(sessionId)}`,
    { cache: "no-store", headers: { Authorization: `Bearer ${session.accessToken}` } }
  );
  const payload = await response.json().catch(() => ({})) as SessionPayload;
  if (!response.ok || payload.error || !payload.session) {
    throw new Error(payload.error ?? "练习结果加载失败。");
  }
  return payload;
}
