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
  missingAnswerAttemptIds = []
}: {
  answers: AttemptHistoryAnswer[];
  attempts: AttemptHistoryAttempt[];
  getAnswerHref: (answer: AttemptHistoryAnswer) => string;
  missingAnswerAttemptIds?: string[];
}) {
  const [incorrectOnly, setIncorrectOnly] = useState(false);
  const missingIds = new Set(missingAnswerAttemptIds);

  return (
    <div className="grid gap-5">
      <div className="flex justify-end">
        <label className="inline-flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm font-semibold">
          <input
            checked={incorrectOnly}
            className="h-4 w-4 accent-ocean"
            onChange={(event) => setIncorrectOnly(event.target.checked)}
            type="checkbox"
          />
          Show incorrect only
        </label>
      </div>
      {attempts.length === 0 ? (
        <p className="rounded-md border border-line bg-white p-5 text-ink/60">
          No attempts found for this set.
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
              className={`rounded-md border p-4 ${
                missingIds.has(attempt.attemptId)
                  ? "border-coral bg-coral/10"
                  : "border-line bg-paper"
              }`}
              key={attempt.attemptId}
            >
              <AttemptHeader attempt={attempt} />
              {missingIds.has(attempt.attemptId) ? (
                <p className="mt-3 text-sm font-semibold text-coral">
                  No answer records were saved for this attempt.
                </p>
              ) : incorrectOnly && visibleAnswers.length === 0 ? (
                <p className="mt-3 text-sm text-ink/60">No incorrect answers.</p>
              ) : (
                <div className="mt-3 flex flex-wrap gap-2">
                  {visibleAnswers.map((answer) => (
                    <AnswerLink
                      answer={answer}
                      href={getAnswerHref(answer)}
                      key={answer.attemptAnswerId}
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

function AttemptHeader({ attempt }: { attempt: AttemptHistoryAttempt }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="font-semibold">{formatDateTime(attempt.submittedAt)}</p>
        <p className="text-sm text-ink/60">
          Accuracy {formatPercent(attempt.accuracy)} · Time {formatDuration(attempt.timeSpentSeconds)}
        </p>
      </div>
    </div>
  );
}

function AnswerLink({ answer, href }: { answer: AttemptHistoryAnswer; href: string }) {
  return (
    <Link
      className={`rounded-md border px-3 py-2 text-sm font-bold ${
        answer.isCorrect
          ? "border-green-200 bg-green-50 text-green-700"
          : "border-red-200 bg-red-50 text-red-700"
      }`}
      href={href}
    >
      Q{answer.questionOrder} · {formatQuestionDuration(answer.questionTimeSeconds)}
    </Link>
  );
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDuration(totalSeconds: number) {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.round(totalSeconds)) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatQuestionDuration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "N/A";
  return formatDuration(seconds);
}

function formatDateTime(value: string | null) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}
