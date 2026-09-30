"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  studentWrongQuestionsCacheKey,
  useStudentCachedData,
  useStudentDataCache,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { PracticeResultSummary } from "@/components/PracticeResult";
import { StudentErrorState, StudentLoadingState, StudentNavigation } from "@/components/student/StudentUI";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { ReadingCorrectionResultPayload } from "@/lib/reading/correctionResult";
import {
  mergeReadingWrongbookSessionResults,
  readingWrongbookSessionShapeCacheKey,
  type ReadingWrongbookSessionGroupResult
} from "@/lib/reading/wrongbookSession";
import { nextWrongQuestionHistoryAmount } from "@/lib/wrongQuestionBank";
import { STUDENT_ROUTES, withStudentReturnTo } from "@/lib/studentNavigation";
import type { WrongQuestionPracticeSession } from "@/lib/wrongQuestionBank";
import { ReadingResultDetailCard } from "./ReadingResult";

type SessionPayload = { error?: string; session?: WrongQuestionPracticeSession };
type GroupResultsState =
  | { status: "error"; error: string }
  | { status: "ready"; groups: ReadingWrongbookSessionGroupResult[] }
  | null;

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
  const [results, setResults] = useState<GroupResultsState>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const groups = session.groups ?? [];
    void (async () => {
      try {
        const { data: { session: authSession } } = await createBrowserSupabase().auth.getSession();
        if (!authSession) throw new Error("请先登录后再查看练习结果。");
        const groupResults = await Promise.all(groups.map(async (group) => {
          const progress = session.progress[group.logicalItemId];
          if (!progress) {
            console.error("Reading session result source not completed", {
              sessionId,
              logicalItemId: group.logicalItemId,
              reason: "source-not-completed"
            });
            throw new Error(`第 ${group.title} 篇材料尚未提交，暂时无法显示完整结果。`);
          }
          const response = await fetch(
            `/api/reading/wrongbook-attempts/${encodeURIComponent(progress.attemptId)}/result`,
            { cache: "no-store", headers: { Authorization: `Bearer ${authSession.access_token}` } }
          );
          const payload = await response.json().catch(() => ({})) as
            ReadingCorrectionResultPayload & { error?: string };
          if (!response.ok || payload.error || !payload.answers || !payload.attempt) {
            console.error("Reading session result source failed", {
              sessionId,
              logicalItemId: group.logicalItemId,
              attemptId: progress.attemptId,
              status: response.status,
              reason: payload.error ?? "invalid-payload"
            });
            throw new Error(payload.error
              ? `第 ${group.title} 篇材料结果加载失败：${payload.error}`
              : `第 ${group.title} 篇材料结果暂时无法加载，请稍后重试。`);
          }
          return { group, payload };
        }));
        if (!cancelled) setResults({ status: "ready", groups: groupResults });
      } catch (failure) {
        if (!cancelled) {
          setResults({
            status: "error",
            error: failure instanceof Error ? failure.message : "练习结果加载失败，请稍后重试。"
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [session, sessionId]);

  // The read-only session review reuses these exact per-source item counts and
  // statuses to position and colour every global question before its own source
  // requests return.
  useEffect(() => {
    if (results?.status !== "ready") return;
    cacheRef.current.setData(
      studentWrongQuestionsCacheKey(readingWrongbookSessionShapeCacheKey(sessionId)),
      results.groups.map(({ group, payload }) => ({
        logicalItemId: group.logicalItemId,
        itemCount: Array.isArray(payload.answers) ? payload.answers.length : 0,
        items: Array.isArray(payload.answers)
          ? payload.answers.map((answer) => ({
              isAnswered: answer.isAnswered,
              isCorrect: answer.isCorrect,
              questionTimeSeconds: answer.questionTimeSeconds
            }))
          : []
      }))
    );
  }, [results, sessionId]);

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
      return <StudentErrorState text="这次练习还没有完成，请回到练习继续作答。" />;
    }
    console.warn("Reading session result loaded while the session status is not completed", {
      sessionId,
      status: session.status
    });
  }
  if (!results) return <StudentLoadingState text="正在加载练习结果..." />;
  if (results.status === "error") return <StudentErrorState text={results.error} />;

  let merged;
  try {
    merged = mergeReadingWrongbookSessionResults(results.groups);
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
  const submittedAt = results.groups.at(-1)?.payload.attempt.submittedAt ?? session.createdAt;

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
