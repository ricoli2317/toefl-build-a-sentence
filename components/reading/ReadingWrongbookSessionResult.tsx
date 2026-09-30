"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  studentWrongQuestionsCacheKey,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { PracticeResultSummary } from "@/components/PracticeResult";
import { StudentErrorState, StudentLoadingState, StudentNavigation } from "@/components/student/StudentUI";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { ReadingCorrectionResultPayload } from "@/lib/reading/correctionResult";
import {
  mergeReadingWrongbookSessionResults,
  type ReadingWrongbookSessionGroupResult
} from "@/lib/reading/wrongbookSession";
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
          if (!progress) throw new Error("这次练习还没有完成。");
          const response = await fetch(
            `/api/reading/wrongbook-attempts/${encodeURIComponent(progress.attemptId)}/result`,
            { cache: "no-store", headers: { Authorization: `Bearer ${authSession.access_token}` } }
          );
          const payload = await response.json().catch(() => ({})) as
            ReadingCorrectionResultPayload & { error?: string };
          if (!response.ok || payload.error || !payload.answers || !payload.attempt) {
            throw new Error(payload.error ?? "练习结果加载失败，请稍后重试。");
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
  }, [session]);

  if (state.loading) return <StudentLoadingState text="正在加载练习结果..." />;
  if (state.error || state.data?.error || !session) {
    return <StudentErrorState text="没有找到练习结果或加载失败。" />;
  }
  if (!results) return <StudentLoadingState text="正在加载练习结果..." />;
  if (results.status === "error") return <StudentErrorState text={results.error} />;

  const merged = mergeReadingWrongbookSessionResults(results.groups);
  const safeReturnTo = returnTo?.trim() || "";
  const selfBase = `/student/wrong-questions/sessions/${encodeURIComponent(sessionId)}`;
  const selfPath = withStudentReturnTo(selfBase, safeReturnTo);
  const title = session.mode === "today" ? "今日错题订正" : "历史错题练习";
  const retakeHref = session.mode === "history" && session.amount
    ? `/student/wrong-questions/history/reading/practice?${new URLSearchParams({
        amount: String(session.amount),
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
