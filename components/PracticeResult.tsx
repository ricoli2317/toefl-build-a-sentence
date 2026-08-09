"use client";

import { useEffect, useState } from "react";
import {
  Clock3,
  ListFilter,
  Target,
  Trophy,
  type LucideIcon
} from "lucide-react";
import { buildSentenceDisplay } from "@/lib/questionText";
import {
  StudentErrorState,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
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
import { shouldShowCorrectAnswer } from "@/lib/resultDisplayPolicy";
import {
  EMPTY_RESULT_PEER_COMPARISON,
  type ResultPeerComparison
} from "@/lib/resultPeerComparison";

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
  source
}: {
  attemptId: string;
  historySetId?: string;
  source?: StudentResultSource;
}) {
  const { data: payload, error, loading } = useStudentCachedData<ResultPayload>(
    studentAttemptCacheKey(attemptId),
    (session) => loadResult(attemptId, session)
  );
  if (loading) {
    return <StudentLoadingState text="正在加载练习结果..." />;
  }

  if (error || !payload) {
    return <StudentErrorState text="未找到练习结果或加载失败。" />;
  }

  const { attempt } = payload;
  const navigation = getStudentResultNavigation(attempt.set_id, {
    historySetId,
    source
  });
  return (
    <PracticeResultView
      navigation={<StudentNavigation
        backHref={navigation.backHref}
        crumbs={navigation.crumbs}
      />}
      payload={payload}
    />
  );
}

export function PracticeResultView({
  answerLabel = "你的答案",
  correctAnswerVisibility = "policy",
  initialQuestionId,
  navigation,
  payload,
  showQuestionTime = false
}: {
  answerLabel?: string;
  correctAnswerVisibility?: "always" | "policy";
  initialQuestionId?: string;
  navigation?: React.ReactNode;
  payload: ResultPayload;
  showQuestionTime?: boolean;
}) {
  const [showIncorrectOnly, setShowIncorrectOnly] = useState(false);
  const { answers, attempt } = payload;
  const peerComparison = payload.peer_comparison ?? EMPTY_RESULT_PEER_COMPARISON;
  const visibleAnswers = showIncorrectOnly ? answers.filter((answer) => !answer.is_correct) : answers;

  useEffect(() => {
    if (!initialQuestionId) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`question-${initialQuestionId}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [initialQuestionId]);

  return (
    <div className="space-y-6">
      {navigation}

      <ResultSummary attempt={attempt} peerComparison={peerComparison} />

      <section className="student-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-bold text-student-text">答题情况</h2>
          <button
            aria-pressed={showIncorrectOnly}
            className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-[10px] border px-3.5 py-2 text-sm font-semibold text-student-primary transition ${
              showIncorrectOnly
                ? "border-student-primary bg-student-primary-soft"
                : "border-student-primary-border bg-white text-student-primary hover:border-student-primary"
            }`}
            onClick={() => setShowIncorrectOnly((value) => !value)}
            type="button"
          >
            <ListFilter aria-hidden="true" size={17} strokeWidth={1.9} />
            只看错题
          </button>
        </div>
        <div className="mt-4 grid gap-3">
          {visibleAnswers.map((answer) => (
            <ResultQuestionCard
              answerLabel={answerLabel}
              answer={answer}
              correctAnswerVisibility={correctAnswerVisibility}
              key={answer.attempt_answer_id}
              setId={attempt.set_id}
              showQuestionTime={showQuestionTime}
            />
          ))}
          {visibleAnswers.length === 0 && showIncorrectOnly ? (
            <p className="student-empty">
              没有错题。
            </p>
          ) : null}
        </div>
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
    <section className="student-card">
      <p className="text-lg font-bold text-student-text">
        {formatResultSetTitle(attempt.set_id, attempt.set_title)}
      </p>
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        <ResultMetricCard
          comparison={formatScoreComparison(peerComparison)}
          icon={Trophy}
          label="得分"
          value={`${attempt.correct_count}/${attempt.total_questions}`}
        />
        <ResultMetricCard
          comparison={formatScoreComparison(peerComparison)}
          icon={Target}
          label="正确率"
          value={`${Math.round(attempt.accuracy * 100)}%`}
        />
        <ResultMetricCard
          comparison={formatTimeComparison(peerComparison)}
          icon={Clock3}
          label="用时"
          tone="error"
          value={formatDuration(attempt.time_spent_seconds)}
        />
      </div>
    </section>
  );
}

function ResultQuestionCard({
  answerLabel,
  answer,
  correctAnswerVisibility,
  setId,
  showQuestionTime
}: {
  answerLabel: string;
  answer: ResultAnswer;
  correctAnswerVisibility: "always" | "policy";
  setId: string;
  showQuestionTime: boolean;
}) {
  const showCorrectAnswer = correctAnswerVisibility === "always" || shouldShowCorrectAnswer({ isCorrect: answer.is_correct, setId });

  return (
    <article
      className={`rounded-xl border p-4 ${
        answer.is_correct
          ? "border-student-primary-border bg-student-primary-soft"
          : "border-student-error-border bg-student-error-soft"
      }`}
      id={`question-${answer.question_id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={answer.is_correct ? "text-sm font-semibold text-student-primary" : "text-sm font-semibold text-student-error"}>
            第 {answer.question_order} 题
          </p>
          <h3 className="mt-1 font-bold leading-6 text-student-text">{answer.prompt}</h3>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {showQuestionTime && answer.question_time_seconds !== null ? (
            <span className="rounded-full border border-student-border bg-white px-3 py-1 text-xs font-semibold text-student-muted">
              用时 {formatDuration(answer.question_time_seconds)}
            </span>
          ) : null}
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold text-white ${
              answer.is_correct ? "bg-student-primary" : "bg-student-error"
            }`}
          >
            {answer.is_correct ? "正确" : "错误"}
          </span>
        </div>
      </div>
      <dl
        className={`mt-4 grid gap-4 text-sm ${
          showCorrectAnswer ? "md:grid-cols-2 md:gap-0" : ""
        }`}
      >
        <div className={showCorrectAnswer ? "md:pr-5" : ""}>
          <dt className="font-semibold text-student-muted">{answerLabel}</dt>
          <dd className="mt-1 leading-6 text-student-text">
            {buildSentenceDisplay(answer.sentence_template, answer.submitted_order_text) ||
              "未作答"}
          </dd>
        </div>
        {showCorrectAnswer ? (
          <div className="md:border-l md:border-student-border md:pl-5">
            <dt className="font-semibold text-student-muted">正确答案</dt>
            <dd className="mt-1 leading-6 text-student-text">
              {buildSentenceDisplay(
                answer.sentence_template,
                answer.correct_order_text,
                answer.final_sentence
              )}
            </dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}

function ResultMetricCard({
  comparison,
  icon: Icon,
  label,
  tone = "primary",
  value
}: {
  comparison: string;
  icon: LucideIcon;
  label: string;
  tone?: "primary" | "error";
  value: string;
}) {
  const error = tone === "error";
  return (
    <div
      className={`flex min-h-[144px] items-center gap-4 rounded-2xl border p-5 ${
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
        <p className="mt-3 text-sm font-medium leading-5 text-student-muted">{comparison}</p>
      </div>
    </div>
  );
}

function formatScoreComparison(comparison: ResultPeerComparison) {
  return comparison.scorePercentile === null
    ? "暂无同伴数据"
    : `超越了 ${comparison.scorePercentile}% 的同学`;
}

function formatTimeComparison(comparison: ResultPeerComparison) {
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
  const response = await fetch(`/api/attempts/${attemptId}`, {
    headers: {
      Authorization: `Bearer ${session.accessToken}`
    }
  });
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

function formatResultSetTitle(setId: string, setTitle: string) {
  if (setId.startsWith("wrongbook-today-")) return "今日错题";
  if (setId.startsWith("wrongbook-random-")) return "历史错题合集 · 随机计时练习";
  if (setId.startsWith("wrongbook-all-")) return "历史错题合集 · 全部练习";
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
