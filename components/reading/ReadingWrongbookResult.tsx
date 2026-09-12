"use client";

import Link from "next/link";
import {
  studentReadingResultCacheKey,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { PracticeResultSummary } from "@/components/PracticeResult";
import { StudentErrorState, StudentLoadingState, StudentNavigation } from "@/components/student/StudentUI";
import type {
  ReadingCorrectionAnswerDisplay,
  ReadingCorrectionResultAnswer,
  ReadingCorrectionResultPayload
} from "@/lib/reading/correctionResult";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export function ReadingWrongbookResult({ attemptId }: { attemptId: string }) {
  const state = useStudentCachedData<ReadingCorrectionResultPayload>(
    studentReadingResultCacheKey(`wrongbook:${attemptId}`),
    (session) => loadResult(attemptId, session)
  );
  if (state.loading) return <StudentLoadingState text="正在加载订正结果..." />;
  if (state.error || !state.data) return <StudentErrorState text="没有找到订正结果或加载失败。" />;

  const { answers, attempt } = state.data;
  const questionHrefBase = `/student/reading/wrongbook-results/${encodeURIComponent(attemptId)}`;
  return (
    <div className="grid gap-6">
      <StudentNavigation
        backHref={STUDENT_ROUTES.wrongQuestions}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: "错题集", href: STUDENT_ROUTES.wrongQuestions },
          { label: "订正结果" }
        ]}
      />
      <PracticeResultSummary
        correctPoints={attempt.correctPoints}
        elapsedSeconds={attempt.elapsedSeconds}
        scoreComparison="本次订正按待订正题计分"
        timeComparison="订正用时不参与班级比较"
        title="订正结果"
        totalPoints={attempt.totalPoints}
      />
      <section className="student-card" data-testid="reading-wrongbook-result-detail">
        <div>
          <h2 className="text-xl font-bold text-student-text">本次订正作答</h2>
          <p className="mt-1 text-sm text-student-muted">答案对比已直接显示；选择题号可查看完整原题。</p>
        </div>
        <ReadingCorrectionAnswerCards
          answers={answers}
          questionHrefBase={questionHrefBase}
        />
      </section>
    </div>
  );
}

function ReadingCorrectionAnswerCards({
  answers,
  questionHrefBase
}: {
  answers: ReadingCorrectionResultAnswer[];
  questionHrefBase: string;
}) {
  return (
    <div className="mt-6 grid gap-3" data-testid="reading-correction-answer-cards">
      {answers.map((answer) => {
        const state = !answer.isAnswered ? "unanswered" : answer.isCorrect ? "correct" : "incorrect";
        return (
          <article
            className={`rounded-xl border p-4 ${answer.isCorrect
              ? "border-student-primary-border bg-student-primary-soft"
              : "border-student-error-border bg-student-error-soft"}`}
            data-answer-state={state}
            key={answer.answerId}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <Link
                className={answer.isCorrect
                  ? "text-sm font-semibold text-student-primary hover:underline"
                  : "text-sm font-semibold text-student-error hover:underline"}
                href={`${questionHrefBase}/questions/${answer.reviewIndex}`}
              >
                第 {answer.order} 题
              </Link>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <span className="rounded-full border border-student-border bg-white px-3 py-1 text-xs font-semibold tabular-nums text-student-muted">
                  用时 {formatQuestionTime(answer.questionTimeSeconds)}
                </span>
                <span className={`rounded-full px-3 py-1 text-xs font-semibold text-white ${answer.isCorrect
                  ? "bg-student-primary"
                  : "bg-student-error"}`}
                >
                  {answer.isCorrect ? "正确" : "错误"}
                </span>
              </div>
            </div>
            <dl className="mt-4 grid gap-4 text-sm md:grid-cols-2 md:gap-0">
              <div className="md:pr-5">
                <dt className="font-semibold text-student-muted">你的答案</dt>
                <dd className="mt-1 break-words leading-6 text-student-text">{answer.studentAnswer}</dd>
              </div>
              <div className="md:border-l md:border-student-border md:pl-5">
                <dt className="font-semibold text-student-muted">正确答案</dt>
                <dd className="mt-1 break-words leading-6 text-student-text">
                  <CorrectionAnswerValue answer={answer.correctAnswer} />
                </dd>
              </div>
            </dl>
          </article>
        );
      })}
    </div>
  );
}

function CorrectionAnswerValue({ answer }: { answer: ReadingCorrectionAnswerDisplay }) {
  if (answer.kind === "text") return answer.text;
  return answer.parts.map((part, index) => (
    <span
      className={part.emphasized ? "font-semibold text-student-primary" : undefined}
      data-ctw-correct-fill={part.emphasized ? "true" : undefined}
      key={`${index}:${part.text}`}
    >
      {part.text}
    </span>
  ));
}

function formatQuestionTime(seconds: number | null) {
  if (seconds === null) return "—";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

async function loadResult(attemptId: string, session: StudentCacheSession) {
  const response = await fetch(
    `/api/reading/wrongbook-attempts/${encodeURIComponent(attemptId)}/result`,
    { cache: "no-store", headers: { Authorization: `Bearer ${session.accessToken}` } }
  );
  const payload = await response.json().catch(() => ({})) as ReadingCorrectionResultPayload & { error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? "订正结果加载失败。");
  return payload;
}
