import type { ReactNode } from "react";

export function ReadingReviewStatusLine({
  className = "",
  isAnswered,
  isCorrect,
  order,
  questionTimeSeconds
}: {
  className?: string;
  isAnswered: boolean;
  isCorrect: boolean;
  order: ReactNode;
  questionTimeSeconds: number | null;
}) {
  const state = !isAnswered ? "未作答" : isCorrect ? "正确" : "错误";
  const tone = isCorrect
    ? "text-student-primary"
    : isAnswered
      ? "text-student-error"
      : "text-student-muted";

  return (
    <p className={`text-sm font-bold ${tone} ${className}`}>
      第{order}题 · {state} · 耗时：{formatReadingReviewQuestionTime(questionTimeSeconds)}
    </p>
  );
}

export function formatReadingReviewQuestionTime(seconds: number | null) {
  if (seconds === null) return "—";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
