"use client";

import Link from "next/link";
import { useState } from "react";

export type AttemptHistoryAttempt = {
  attemptId: string;
  accuracy: number;
  timeSpentSeconds: number;
  submittedAt: string | null;
};

export type AttemptHistoryAnswer = {
  attemptAnswerId: string;
  attemptId: string;
  questionId: string;
  questionOrder: number;
  isCorrect: boolean;
  questionTimeSeconds: number | null;
};

export function AttemptHistoryList({
  answers,
  attempts,
  getAnswerHref,
  locale = "en",
  missingAnswerAttemptIds = [],
  variant = "default"
}: {
  answers: AttemptHistoryAnswer[];
  attempts: AttemptHistoryAttempt[];
  getAnswerHref: (answer: AttemptHistoryAnswer) => string;
  locale?: "en" | "zh-CN";
  missingAnswerAttemptIds?: string[];
  variant?: "default" | "student";
}) {
  const [incorrectOnly, setIncorrectOnly] = useState(false);
  const missingIds = new Set(missingAnswerAttemptIds);

  return (
    <div className="grid gap-5">
      <div className="flex justify-end">
        <label
          className={
            variant === "student"
              ? "inline-flex items-center gap-2 rounded-[10px] border border-student-primary-border bg-white px-3 py-2 text-sm font-semibold text-student-primary"
              : "inline-flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm font-semibold"
          }
        >
          <input
            checked={incorrectOnly}
            className={variant === "student" ? "h-4 w-4 accent-student-primary" : "h-4 w-4 accent-ocean"}
            onChange={(event) => setIncorrectOnly(event.target.checked)}
            type="checkbox"
          />
          {locale === "zh-CN" ? "只看错题" : "Show incorrect only"}
        </label>
      </div>
      {attempts.length === 0 ? (
        <p className={variant === "student" ? "student-empty" : "rounded-md border border-line bg-white p-5 text-ink/60"}>
          {locale === "zh-CN" ? "暂无练习记录。" : "No attempts found for this set."}
        </p>
      ) : null}
      <div className="grid gap-4">
        {attempts.map((attempt) => {
          const attemptAnswers = answers
            .filter((answer) => answer.attemptId === attempt.attemptId)
            .sort((left, right) => left.questionOrder - right.questionOrder);
          const visibleAnswers = incorrectOnly
            ? attemptAnswers.filter((answer) => !answer.isCorrect)
            : attemptAnswers;

          return (
            <div
              className={`${variant === "student" ? "rounded-2xl" : "rounded-md"} border p-4 ${
                missingIds.has(attempt.attemptId)
                  ? variant === "student"
                    ? "border-student-error-border bg-student-error-soft"
                    : "border-coral bg-coral/10"
                  : variant === "student"
                    ? "border-student-border bg-white"
                    : "border-line bg-paper"
              }`}
              key={attempt.attemptId}
            >
              <AttemptHeader attempt={attempt} locale={locale} variant={variant} />
              {missingIds.has(attempt.attemptId) ? (
                <p className={variant === "student" ? "mt-3 text-sm font-semibold text-student-error" : "mt-3 text-sm font-semibold text-coral"}>
                  {locale === "zh-CN"
                    ? "本次练习未保存答题记录。"
                    : "No answer records were saved for this attempt."}
                </p>
              ) : incorrectOnly && visibleAnswers.length === 0 ? (
                <p className={variant === "student" ? "mt-3 text-sm text-student-muted" : "mt-3 text-sm text-ink/60"}>
                  {locale === "zh-CN" ? "没有错题。" : "No incorrect answers."}
                </p>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  {visibleAnswers.map((answer) => (
                    <AnswerLink
                      answer={answer}
                      href={getAnswerHref(answer)}
                      key={answer.attemptAnswerId}
                      locale={locale}
                      variant={variant}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AttemptHeader({
  attempt,
  locale,
  variant
}: {
  attempt: AttemptHistoryAttempt;
  locale: "en" | "zh-CN";
  variant: "default" | "student";
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="font-semibold">{formatDateTime(attempt.submittedAt, locale)}</p>
        <p className={variant === "student" ? "text-sm text-student-muted" : "text-sm text-ink/60"}>
          {locale === "zh-CN" ? "正确率" : "Accuracy"} {formatPercent(attempt.accuracy)} ·{" "}
          {locale === "zh-CN" ? "用时" : "Time"} {formatDuration(attempt.timeSpentSeconds, locale)}
        </p>
      </div>
    </div>
  );
}

function AnswerLink({
  answer,
  href,
  locale,
  variant
}: {
  answer: AttemptHistoryAnswer;
  href: string;
  locale: "en" | "zh-CN";
  variant: "default" | "student";
}) {
  return (
    <Link
      className={`${variant === "student" ? "rounded-[10px]" : "rounded-md"} border px-3 py-2 text-sm font-bold ${
        answer.isCorrect
          ? variant === "student"
            ? "border-student-primary-border bg-student-primary-soft text-student-primary"
            : "border-green-200 bg-green-50 text-green-700"
          : variant === "student"
            ? "border-student-error-border bg-student-error-soft text-student-error"
            : "border-red-200 bg-red-50 text-red-700"
      }`}
      href={href}
    >
      {locale === "zh-CN" ? `第${answer.questionOrder}题` : `Q${answer.questionOrder}`} ·{" "}
      {formatQuestionDuration(answer.questionTimeSeconds, locale)}
    </Link>
  );
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(totalSeconds: number, locale: "en" | "zh-CN") {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.round(totalSeconds)) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return locale === "zh-CN"
    ? `${minutes}:${String(seconds).padStart(2, "0")}`
    : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatQuestionDuration(seconds: number | null, locale: "en" | "zh-CN") {
  if (seconds === null || !Number.isFinite(seconds)) return locale === "zh-CN" ? "暂无" : "N/A";
  return formatDuration(seconds, locale);
}

function formatDateTime(value: string | null, locale: "en" | "zh-CN") {
  if (!value) return locale === "zh-CN" ? "时间未知" : "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return locale === "zh-CN" ? "时间未知" : "Unknown time";
  return date.toLocaleString(locale === "zh-CN" ? "zh-CN" : [], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
