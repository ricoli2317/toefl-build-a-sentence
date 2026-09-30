"use client";

import Link from "next/link";
import {
  studentWrongQuestionsCacheKey,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import { STUDENT_ROUTES, withStudentReturnTo } from "@/lib/studentNavigation";
import {
  WRONG_QUESTION_BANK_LABELS,
  type WrongQuestionPracticeSession
} from "@/lib/wrongQuestionBank";

type SessionPayload = { error?: string; session?: WrongQuestionPracticeSession };

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
  if (state.loading) return <StudentLoadingState text="正在加载练习结果..." />;
  if (state.error || !state.data?.session) {
    return <StudentErrorState text="没有找到练习结果或加载失败。" />;
  }

  const session = state.data.session;
  const groups = session.groups ?? [];
  const backHref = returnTo?.trim() || STUDENT_ROUTES.wrongQuestions;
  const selfQuery = new URLSearchParams();
  if (returnTo) selfQuery.set("returnTo", returnTo);
  const selfPath = `/student/wrong-questions/sessions/${encodeURIComponent(sessionId)}${
    selfQuery.size > 0 ? `?${selfQuery.toString()}` : ""
  }`;
  const completedGroups = groups.filter((group) => session.progress[group.logicalItemId]);
  const correctPoints = completedGroups.reduce(
    (sum, group) => sum + (session.progress[group.logicalItemId]?.correctPoints ?? 0),
    0
  );
  const totalPoints = completedGroups.reduce(
    (sum, group) => sum + (session.progress[group.logicalItemId]?.totalPoints ?? 0),
    0
  );
  const unfinishedIndex = groups.findIndex((group) => !session.progress[group.logicalItemId]);
  const practiceHref = `${session.mode === "today" ? "today" : "history"}/reading/practice?${
    new URLSearchParams({
      ...(returnTo ? { returnTo } : {}),
      session: sessionId,
      taskType: session.taskType
    }).toString()
  }`;

  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={backHref}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: "错题集", href: STUDENT_ROUTES.wrongQuestions },
          { label: "练习结果" }
        ]}
      />

      <section className="student-card" data-testid="reading-bank-session-summary">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-student-text">
              {session.mode === "today" ? "今日错题练习结果" : "历史错题练习结果"}
            </h2>
            <p className="mt-1 text-sm text-student-muted">
              {WRONG_QUESTION_BANK_LABELS[session.taskType]} · 已订正 {completedGroups.length} / {groups.length} 篇
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold text-student-muted">本次得分</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-student-text">
              <span className="text-student-primary">{correctPoints}</span>
              <span className="mx-1 text-student-muted">/</span>
              {totalPoints}
            </p>
          </div>
        </div>
      </section>

      <section className="student-card" data-testid="reading-bank-session-groups">
        <h3 className="text-lg font-bold text-student-text">练习内容</h3>
        <ul className="mt-3 divide-y divide-student-border">
          {groups.map((group, index) => {
            const progress = session.progress[group.logicalItemId];
            return (
              <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={group.logicalItemId}>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-student-text">
                    {index + 1}. {group.title || group.logicalItemId}
                  </p>
                  <p className="mt-0.5 text-xs font-semibold text-student-muted">
                    {group.targets.length} 道错题
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {progress ? (
                    <>
                      <span className="text-sm font-semibold tabular-nums text-student-primary">
                        已订正 {progress.correctPoints} / {progress.totalPoints}
                      </span>
                      <Link
                        className="student-button-secondary min-h-9 px-3.5 py-1.5 text-sm"
                        href={withStudentReturnTo(
                          `/student/reading/wrongbook-results/${encodeURIComponent(progress.attemptId)}`,
                          selfPath
                        )}
                      >
                        查看订正结果
                      </Link>
                    </>
                  ) : (
                    <span className="text-sm font-semibold text-student-muted">
                      {index === unfinishedIndex ? "待订正" : "未开始"}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {unfinishedIndex >= 0 ? (
          <div className="mt-4 border-t border-student-border pt-4">
            <Link className="student-button-error min-h-10 px-4 py-2 text-sm" href={practiceHref}>
              继续本次练习
            </Link>
          </div>
        ) : null}
      </section>
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
