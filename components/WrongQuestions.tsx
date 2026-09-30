"use client";

import { useEffect, useMemo, useState } from "react";
import { PracticeSession } from "@/components/PracticeSession";
import {
  StudentEmptyState,
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import {
  studentWrongQuestionsCacheKey,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";
import type { WrongQuestionPracticeSession } from "@/lib/wrongQuestionBank";
import type { PublicQuestion } from "@/lib/types";

type WrongQuestionsPayload = {
  correctionMode?: "history" | "today";
  count?: number;
  error?: string;
  questions?: PublicQuestion[];
  session?: WrongQuestionPracticeSession;
};

/**
 * BAS wrong-question practice for the three entry flows:
 *   * today   - pending bank questions (今日错题)
 *   * history - frozen random session from the history bank (历史错题)
 *   * entry   - one formal/history attempt's wrong questions (entry 订正)
 */
export function WrongQuestionsPractice({
  amount,
  attemptId,
  mode = "all",
  returnTo,
  scope,
  sessionId
}: {
  amount?: number;
  attemptId?: string;
  mode?: "all" | "random";
  returnTo?: string | null;
  scope: "entry" | "history" | "today";
  sessionId?: string;
}) {
  const historySession = scope === "history";
  const sessionQuery = useMemo(() => historySession
    ? new URLSearchParams({
        amount: mode === "random" && amount ? String(amount) : "",
        mode: "history",
        taskType: "bas",
        ...(sessionId ? { sessionId } : {})
      }).toString()
    : null, [amount, historySession, mode, sessionId]);
  const directQuery = useMemo(() => {
    if (scope === "today") return new URLSearchParams({ scope: "today" }).toString();
    if (scope === "entry" && attemptId) {
      return new URLSearchParams({ attemptId, scope: "entry" }).toString();
    }
    return null;
  }, [attemptId, scope]);

  const sessionState = useStudentCachedData<WrongQuestionsPayload>(
    studentWrongQuestionsCacheKey(`bas-session:${sessionQuery ?? "none"}`),
    (session) => loadBasSession(sessionQuery ?? "", session),
    { enabled: Boolean(sessionQuery) }
  );
  const directState = useStudentCachedData<WrongQuestionsPayload>(
    studentWrongQuestionsCacheKey(`bas-questions:${directQuery ?? "none"}`),
    (session) => loadWrongQuestions(directQuery ?? "", session),
    { enabled: Boolean(directQuery) }
  );
  const activeState = historySession ? sessionState : directState;
  const payload = activeState.data;
  const questions = payload?.questions ?? [];
  const sessionKey = sessionQuery ?? directQuery ?? "";
  const [questionSnapshot, setQuestionSnapshot] = useState<{
    key: string;
    questions: PublicQuestion[];
  } | null>(null);
  useEffect(() => {
    if (activeState.loading || activeState.error || questionSnapshot?.key === sessionKey) return;
    setQuestionSnapshot({ key: sessionKey, questions: [...questions] });
  }, [activeState.error, activeState.loading, questionSnapshot?.key, questions, sessionKey]);
  const sessionQuestions = questionSnapshot?.key === sessionKey
    ? questionSnapshot.questions
    : null;

  // A freshly created history session is pinned into the URL, so a refresh or
  // back-navigation resumes the exact same draw instead of re-randomizing.
  useEffect(() => {
    if (!historySession || sessionId) return;
    const createdSessionId = payload?.session?.sessionId;
    if (!createdSessionId || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("session") === createdSessionId) return;
    url.searchParams.set("session", createdSessionId);
    window.history.replaceState(null, "", url.toString());
  }, [historySession, payload?.session?.sessionId, sessionId]);

  const stamp = useMemo(() => formatTimestamp(new Date()), []);
  const correctionMode = payload?.correctionMode ?? "today";
  const clearsPendingToday = scope === "today" || (scope === "entry" && correctionMode === "today");
  const virtualSetId = useMemo(() => clearsPendingToday
    ? `wrongbook-today-${stamp.slice(0, 8)}`
    : `wrongbook-random-${stamp}`, [clearsPendingToday, stamp]);
  const title = scope === "today"
    ? "今日错题订正"
    : scope === "entry"
      ? correctionMode === "today"
        ? "错题订正"
        : "历史错题订正"
      : "历史错题练习";

  if (activeState.error) {
    return <StudentErrorState text="加载错题练习失败，请稍后重试。" />;
  }
  if (activeState.loading || !sessionQuestions) {
    return <StudentLoadingState text="正在加载练习..." />;
  }
  if (sessionQuestions.length === 0) {
    return (
      <div className="grid gap-5">
        <WrongQuestionsNavigation current={title} />
        <StudentEmptyState text={scope === "today"
          ? "今日无错题。"
          : scope === "entry"
            ? "本次练习没有需要订正的错题。"
            : "该题型暂无历史错题。"} />
      </div>
    );
  }

  return (
    <PracticeSession
      hideQuestionCardNumber
      initialQuestions={sessionQuestions}
      returnTo={returnTo}
      setId={virtualSetId}
      setTitle={title}
      stopwatch={historySession}
      timed={false}
      totalSeconds={1}
    />
  );
}

function WrongQuestionsNavigation({ current }: { current: string }) {
  return (
    <StudentNavigation
      backHref={STUDENT_ROUTES.wrongQuestions}
      crumbs={[
        { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
        { label: STUDENT_UI_TEXT.wrongQuestions, href: STUDENT_ROUTES.wrongQuestions },
        { label: current }
      ]}
    />
  );
}

async function loadWrongQuestions(query: string, session: StudentCacheSession) {
  const response = await fetch(`/api/wrong-questions?${query}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as WrongQuestionsPayload;
  if (!response.ok || payload.error) throw new Error(payload.error ?? "无法加载错题练习。");
  return payload;
}

async function loadBasSession(query: string, session: StudentCacheSession) {
  const params = new URLSearchParams(query);
  const existingSessionId = params.get("sessionId")?.trim() ?? "";
  const response = existingSessionId
    ? await fetch(`/api/wrong-questions/sessions/${encodeURIComponent(existingSessionId)}`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${session.accessToken}` }
      })
    : await fetch("/api/wrong-questions/sessions", {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: params.get("amount") ? Number(params.get("amount")) : null,
          mode: "history",
          taskType: "bas"
        })
      });
  const payload = await response.json().catch(() => ({})) as WrongQuestionsPayload;
  if (!response.ok || payload.error || !payload.session) {
    throw new Error(payload.error ?? "无法加载错题练习。");
  }
  return payload;
}

function formatTimestamp(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}
