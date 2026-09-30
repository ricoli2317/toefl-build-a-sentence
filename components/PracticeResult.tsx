"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Clock3,
  Target,
  Trophy,
  type LucideIcon
} from "lucide-react";
import { buildSentenceDisplay, splitTextItems } from "@/lib/questionText";
import { buildBasReviewQuestionState } from "@/lib/basReviewState";
import { QuestionDisplay } from "@/components/shared/QuestionDisplay";
import {
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  studentAttemptCacheKey,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  getStudentResultNavigation,
  isGrammarPracticeSetId,
  type StudentResultSource
} from "@/lib/studentNavigation";
import {
  EMPTY_RESULT_PEER_COMPARISON,
  type ResultPeerComparison
} from "@/lib/resultPeerComparison";
import {
  logStudentPerformance,
  measureStudentRequest
} from "@/lib/studentPerformance.client";

export type ResultAttempt = {
  attempt_id: string;
  set_id: string;
  set_title: string;
  correct_count: number;
  total_questions: number;
  accuracy: number;
  time_spent_seconds: number;
  submitted_at: string;
};

export type ResultAnswer = {
  attempt_answer_id: string;
  question_id: string;
  question_order: number;
  prompt: string;
  submitted_order_text: string;
  correct_order_text: string;
  sentence_template: string;
  options_text: string;
  final_sentence: string;
  is_correct: boolean;
  grammar_tags_text: string | null;
  question_time_seconds: number | null;
};

export type ResultPayload = {
  attempt: ResultAttempt;
  total_count: number;
  correct_count: number;
  accuracy: number;
  peer_comparison?: ResultPeerComparison;
  answers: ResultAnswer[];
};

export function PracticeResult({
  attemptId,
  historySetId,
  returnTo,
  source
}: {
  attemptId: string;
  historySetId?: string;
  returnTo?: string | string[];
  source?: StudentResultSource;
}) {
  const { data: payload, error, loading } = useStudentCachedData<ResultPayload>(
    studentAttemptCacheKey(attemptId),
    (session) => loadResult(attemptId, session)
  );
  const [peerComparison, setPeerComparison] = useState<ResultPeerComparison | null>(null);
  const peerRequestAttemptRef = useRef<string | null>(null);

  useEffect(() => {
    if (!payload?.attempt) return;
    if (payload.peer_comparison) {
      setPeerComparison(payload.peer_comparison);
      return;
    }
    if (peerRequestAttemptRef.current === attemptId) return;
    peerRequestAttemptRef.current = attemptId;
    let cancelled = false;
    const startedAt = performance.now();

    void loadPeerComparison(attemptId).then(
      (comparison) => {
        if (cancelled) return;
        setPeerComparison(comparison);
        logStudentPerformance({
          event: "bas_peer_comparison_ready",
          outcome: "success",
          totalMs: roundDuration(performance.now() - startedAt)
        });
      },
      () => {
        logStudentPerformance({
          event: "bas_peer_comparison_ready",
          outcome: "error",
          totalMs: roundDuration(performance.now() - startedAt)
        });
      }
    );

    return () => {
      cancelled = true;
    };
  }, [attemptId, payload?.attempt, payload?.peer_comparison]);
  if (loading) {
    return <StudentLoadingState text="正在加载练习结果..." />;
  }

  if (error || !payload) {
    return <StudentErrorState text="未找到练习结果或加载失败。" />;
  }

  const { attempt } = payload;
  const navigation = getStudentResultNavigation(attempt.set_id, {
    historySetId,
    returnTo,
    source
  });
  return (
    <PracticeResultView
      navigation={<StudentNavigation
        backHref={navigation.backHref}
        crumbs={navigation.crumbs}
      />}
      payload={peerComparison ? { ...payload, peer_comparison: peerComparison } : payload}
      showCorrection
    />
  );
}

/**
 * Entry-level correction for this attempt only. The button uses data the result
 * page already has (wrong answer chips), adds no first-screen request, and
 * carries the current result URL as `returnTo` so finishing the correction
 * returns to this exact result view.
 */
function CorrectionEntryButton({ attemptId }: { attemptId: string }) {
  const router = useRouter();
  return (
    <button
      className="student-button-correction"
      data-testid="wrong-question-correction-entry"
      onClick={() => {
        const returnTo = typeof window === "undefined"
          ? `/student/results/${encodeURIComponent(attemptId)}`
          : `${window.location.pathname}${window.location.search}`;
        router.push(`/student/wrong-questions/history/practice?${new URLSearchParams({
          attemptId,
          returnTo,
          scope: "entry"
        }).toString()}`);
      }}
      type="button"
    >
      错题订正
    </button>
  );
}

export function PracticeResultView({
  initialQuestionId,
  navigation,
  payload,
  showCorrection = false
}: {
  initialQuestionId?: string;
  navigation?: React.ReactNode;
  payload: ResultPayload;
  /** Student-only entry correction link; teacher views never show it. */
  showCorrection?: boolean;
}) {
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(() =>
    initialQuestionId
    && payload.answers.some((answer) => answer.question_id === initialQuestionId)
      ? initialQuestionId
      : null
  );
  const { answers, attempt } = payload;
  const peerComparison = payload.peer_comparison ?? EMPTY_RESULT_PEER_COMPARISON;
  const activeAnswerIndex = activeQuestionId
    ? answers.findIndex((answer) => answer.question_id === activeQuestionId)
    : -1;
  const activeAnswer = activeAnswerIndex >= 0 ? answers[activeAnswerIndex] : null;
  const activeReadonlyState = activeAnswer
    ? buildBasReviewQuestionState({
        optionsText: activeAnswer.options_text,
        questionId: activeAnswer.question_id,
        submittedOrderText: activeAnswer.submitted_order_text
      })
    : null;
  const activeQuestionTimeSeconds =
    activeAnswer && Number.isFinite(activeAnswer.question_time_seconds)
      ? activeAnswer.question_time_seconds
      : null;

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#question-")) return;
    let questionId = hash.slice("#question-".length);
    try {
      questionId = decodeURIComponent(questionId);
    } catch {
      // Keep the raw hash so an unencoded question id can still match.
    }
    if (answers.some((answer) => answer.question_id === questionId)) {
      setActiveQuestionId(questionId);
    }
  }, [answers]);

  useEffect(() => {
    const questionId = initialQuestionId ?? activeQuestionId;
    if (!questionId) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`question-${questionId}`)?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeQuestionId, initialQuestionId]);

  return (
      <div className="space-y-6">
        {navigation}
        <ResultSummary attempt={attempt} peerComparison={peerComparison} />
        <section className="student-card" data-testid="practice-result-detail">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold text-student-text">作答详情</h2>
              <p className="mt-1 text-sm text-student-muted">
                提交于 {formatSubmittedAt(attempt.submitted_at)}
              </p>
            </div>
            {showCorrection && answers.some((answer) => !answer.is_correct) ? (
              <CorrectionEntryButton attemptId={attempt.attempt_id} />
            ) : null}
          </div>
          <div
            className="mt-4 flex flex-wrap justify-center gap-3"
            data-testid="practice-result-question-chips"
          >
            {answers.map((answer) => {
              const selected = answer.question_id === activeQuestionId;
              return (
                <button
                  aria-current={selected ? "true" : undefined}
                  aria-label={`第${answer.question_order}题，${answer.is_correct ? "正确" : "错误"}`}
                  className={`inline-flex h-10 w-10 items-center justify-center rounded-full border text-sm font-semibold tabular-nums transition ${resultAnswerToneClassName(answer.is_correct)} ${
                    selected
                      ? answer.is_correct
                        ? "border-student-primary ring-2 ring-student-primary-border"
                        : "border-student-error ring-2 ring-student-error-border"
                      : ""
                  }`}
                  data-answer-state={answer.is_correct ? "correct" : "incorrect"}
                  key={answer.attempt_answer_id}
                  onClick={() => setActiveQuestionId(answer.question_id)}
                  type="button"
                >
                  {answer.question_order}
                </button>
              );
            })}
          </div>
          {activeAnswer && activeReadonlyState ? (
            <div
              className="mt-5 grid gap-5 border-t border-student-border pt-5"
              data-testid="practice-result-readonly-question"
              id={`question-${activeAnswer.question_id}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <button
                  className="student-button-secondary min-h-9 px-3.5"
                  onClick={() => setActiveQuestionId(null)}
                  type="button"
                >
                  <ArrowLeft aria-hidden="true" size={16} />
                  返回结果
                </button>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-student-text">
                    第 {activeAnswer.question_order} 题 / 共 {attempt.total_questions} 题
                  </p>
                  {activeQuestionTimeSeconds !== null ? (
                    <span className="rounded-full border border-student-border bg-white px-3 py-1 text-xs font-semibold text-student-muted">
                      用时 {formatDuration(activeQuestionTimeSeconds)}
                    </span>
                  ) : null}
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold text-white ${
                      activeAnswer.is_correct ? "bg-student-primary" : "bg-student-error"
                    }`}
                  >
                    {activeAnswer.is_correct ? "正确" : "错误"}
                  </span>
                </div>
              </div>
              <QuestionDisplay
                answers={activeReadonlyState.placedChunks}
                hideQuestionNumber
                locale="zh-CN"
                options={activeReadonlyState.optionChunks}
                prompt={activeAnswer.prompt}
                questionNumber={activeAnswer.question_order}
                readOnly
                template={activeAnswer.sentence_template}
              />
              {/* Same correct-answer presentation the teacher question bank shows for a BAS question. */}
              <section className="teacher-card border-student-primary-border bg-student-primary-soft/55 p-5">
                <p className="text-sm font-semibold text-student-primary">正确答案</p>
                <p className="mt-2 text-lg font-semibold leading-7 text-student-text">
                  {activeAnswer.final_sentence ||
                    buildSentenceDisplay(
                      activeAnswer.sentence_template,
                      activeAnswer.correct_order_text
                    ) ||
                    splitTextItems(activeAnswer.correct_order_text).join(" ")}
                </p>
              </section>
              <div className="flex flex-wrap justify-end gap-3">
                <button
                  className="student-button-secondary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={activeAnswerIndex === 0}
                  onClick={() =>
                    setActiveQuestionId(answers[activeAnswerIndex - 1]?.question_id ?? activeAnswer.question_id)
                  }
                  type="button"
                >
                  上一题
                </button>
                <button
                  className="student-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={activeAnswerIndex === answers.length - 1}
                  onClick={() =>
                    setActiveQuestionId(answers[activeAnswerIndex + 1]?.question_id ?? activeAnswer.question_id)
                  }
                  type="button"
                >
                  下一题
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    );
}

function ResultSummary({
  attempt,
  peerComparison
}: {
  attempt: ResultAttempt;
  peerComparison: ResultPeerComparison;
}) {
  return (
    <PracticeResultSummary
      correctPoints={attempt.correct_count}
      elapsedSeconds={attempt.time_spent_seconds}
      scoreComparison={formatScoreComparison(peerComparison)}
      timeComparison={formatTimeComparison(peerComparison)}
      title={formatResultSetTitle(attempt.set_id, attempt.set_title)}
      totalPoints={attempt.total_questions}
    />
  );
}

/** Shared BAS/Reading result summary. Domain-specific result data stays outside. */
export function PracticeResultSummary({
  correctPoints,
  elapsedSeconds,
  incorrectPoints,
  scoreComparison = "练习已完成",
  scoreValue,
  timeComparison = "本次练习用时",
  title,
  totalPoints,
  unansweredPoints
}: {
  correctPoints: number;
  elapsedSeconds: number | null;
  incorrectPoints?: number;
  scoreComparison?: string | null;
  scoreValue?: string;
  timeComparison?: string | null;
  title: string;
  totalPoints: number;
  unansweredPoints?: number;
}) {
  const accuracy = totalPoints > 0
    ? Math.round((correctPoints / totalPoints) * 100)
    : 0;
  return (
    <section className="student-card" data-testid="practice-result-summary">
      <p className="text-lg font-bold text-student-text">{title}</p>
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <ResultMetricCard
          comparison={scoreComparison}
          icon={Trophy}
          label="得分"
          value={scoreValue ?? `${correctPoints}/${totalPoints}`}
        />
        <ResultMetricCard
          comparison={scoreComparison}
          icon={Target}
          label="正确率"
          value={`${accuracy}%`}
        />
        <ResultMetricCard
          comparison={timeComparison}
          icon={Clock3}
          label="用时"
          tone="error"
          value={elapsedSeconds === null ? "—" : formatDuration(elapsedSeconds)}
        />
      </div>
      {incorrectPoints !== undefined && unansweredPoints !== undefined ? (
        <p className="mt-4 text-sm font-semibold text-student-muted" data-testid="reading-result-breakdown">
          答错 {incorrectPoints} · 未作答 {unansweredPoints}
        </p>
      ) : null}
    </section>
  );
}

function ResultMetricCard({
  comparison,
  icon: Icon,
  label,
  tone = "primary",
  value
}: {
  comparison: string | null;
  icon: LucideIcon;
  label: string;
  tone?: "primary" | "error";
  value: string;
}) {
  const error = tone === "error";
  return (
    <div
      className={`flex items-center gap-4 rounded-2xl border p-5 ${comparison ? "min-h-[144px]" : ""} ${
        error
          ? "border-student-error-border bg-student-error-soft"
          : "border-student-primary-border bg-student-primary-soft"
      }`}
    >
      <span
        className={`inline-flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border bg-white/55 ${
          error
            ? "border-student-error-border text-student-error"
            : "border-student-primary-border text-student-primary"
        }`}
      >
        <Icon aria-hidden="true" size={37} strokeWidth={1.9} />
      </span>
      <div className="min-w-0">
        <p className="text-base font-semibold text-student-muted">{label}</p>
        <p
          className={`mt-1 text-[2.625rem] font-bold leading-none tracking-tight ${
            error ? "text-student-error" : "text-student-primary"
          }`}
        >
          {value}
        </p>
        {comparison ? (
          <p className="mt-3 text-sm font-medium leading-5 text-student-muted">{comparison}</p>
        ) : null}
      </div>
    </div>
  );
}

export const RESULT_COMPARISON_LOADING_TEXT = "正在加载同班比较…";

export function formatScoreComparison(comparison: ResultPeerComparison) {
  return comparison.scorePercentile === null
    ? "暂无同伴数据"
    : `超越了 ${comparison.scorePercentile}% 的同学`;
}

export function formatTimeComparison(comparison: ResultPeerComparison) {
  const timeComparison = comparison.timeComparison;
  if (!timeComparison) return "暂无同伴数据";
  if (timeComparison.direction === "same") return "与平均用时基本一致";
  return `比平均用时${timeComparison.direction === "faster" ? "快" : "慢"} ${timeComparison.percent}%`;
}

function getErrorMessage(value: ResultPayload | { error?: string }, fallback: string) {
  return "error" in value && value.error ? value.error : fallback;
}

async function loadResult(
  attemptId: string,
  session: StudentCacheSession
): Promise<ResultPayload> {
  const response = await measureStudentRequest(
    `GET /api/attempts/${encodeURIComponent(attemptId)}`,
    async (captureResponse) => {
      const resultResponse = await fetch(`/api/attempts/${encodeURIComponent(attemptId)}`, {
        headers: {
          Authorization: `Bearer ${session.accessToken}`
        }
      });
      captureResponse(resultResponse);
      return resultResponse;
    }
  );
  const responseText = await response.text();
  let data: ResultPayload | { error?: string };

  try {
    data = responseText
      ? JSON.parse(responseText)
      : { error: "练习结果服务返回了空响应。" };
  } catch {
    data = { error: "练习结果服务返回的数据格式无效。" };
  }

  if (!response.ok || "error" in data) {
    throw new Error(getErrorMessage(data, "无法加载练习结果。"));
  }

  return data as ResultPayload;
}

async function loadPeerComparison(attemptId: string): Promise<ResultPeerComparison> {
  const {
    data: { session }
  } = await createBrowserSupabase().auth.getSession();
  const response = await measureStudentRequest(
    `GET /api/attempts/${encodeURIComponent(attemptId)}/peer-comparison`,
    async (captureResponse) => {
      const peerResponse = await fetch(
        `/api/attempts/${encodeURIComponent(attemptId)}/peer-comparison`,
        {
          headers: { Authorization: `Bearer ${session?.access_token ?? ""}` }
        }
      );
      captureResponse(peerResponse);
      return peerResponse;
    }
  );
  const payload = (await response.json()) as {
    error?: string;
    peer_comparison?: ResultPeerComparison;
  };
  if (!response.ok || payload.error || !payload.peer_comparison) {
    throw new Error(payload.error ?? "无法加载同伴对比。");
  }
  return payload.peer_comparison;
}

function roundDuration(value: number) {
  return Math.round(value * 10) / 10;
}

function formatResultSetTitle(setId: string, setTitle: string) {
  if (setId.startsWith("wrongbook-today-")) return "今日错题订正";
  if (setId.startsWith("wrongbook-random-") || setId.startsWith("wrongbook-all-")) {
    return "历史错题练习";
  }
  if (isGrammarPracticeSetId(setId)) {
    const separatorIndex = setTitle.indexOf(" · ");
    const grammarTag = separatorIndex >= 0 ? setTitle.slice(separatorIndex + 3).trim() : "";
    return grammarTag ? `按语法分类练习 · ${grammarTag}` : "按语法分类练习";
  }
  return setTitle;
}

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** BAS result status tones: correct keeps the product primary, wrong keeps the error tone. */
function resultAnswerToneClassName(isCorrect: boolean) {
  return isCorrect
    ? "border-student-primary-border bg-student-primary-soft text-student-primary"
    : "border-student-error-border bg-student-error-soft text-student-error";
}

function formatSubmittedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
