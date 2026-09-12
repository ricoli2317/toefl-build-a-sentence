"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { isReadingAttemptSummary } from "@/lib/reading/attempts";
import type { ReadingCorrectionAnswerPresentation } from "@/lib/reading/correctionResult";
import type { SubmittedReadingReviewPayload } from "@/lib/reading/review";
import type { SubmittedReadingReviewItem } from "@/lib/reading/review";
import type { ReadingAnswerState } from "@/lib/reading/practiceState";
import type { StudentReadingPracticePayload } from "@/lib/reading/studentPractice";
import { readingLookupEnabled } from "@/lib/reading/lookupCapabilities";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { ReadingCorrectionAnswerValue } from "./ReadingCorrectionAnswerValue";
import {
  ReadingPracticeMessage,
  ReadingPracticeShell,
  ReadingWorkspaceRouter,
  readingTwoColumnScaleStyle
} from "./ReadingPractice";

type Payload = Partial<SubmittedReadingReviewPayload> & {
  disclosures?: Record<string, ReadingCorrectionAnswerPresentation>;
  error?: string;
  fullSet?: boolean;
  occurrences?: FullSetReviewOccurrence[];
  reviewItems?: FullSetReviewItem[];
};

type FullSetReviewOccurrence = {
  answers: ReadingAnswerState;
  occurrenceId: string;
  practice: StudentReadingPracticePayload;
};

type FullSetReviewItem = SubmittedReadingReviewItem & {
  moduleNumber: 1 | 2;
  occurrenceId: string;
  taskType: "ctw" | "rdl" | "rap";
};

type FullSetReview = {
  attempt: { attemptId: string; title: string };
  disclosures: Record<string, ReadingCorrectionAnswerPresentation>;
  fullSet: true;
  occurrences: FullSetReviewOccurrence[];
  reviewItems: FullSetReviewItem[];
};

type StandardReview = SubmittedReadingReviewPayload & {
  disclosures: Record<string, ReadingCorrectionAnswerPresentation>;
  fullSet?: false;
};

export function ReadingWrongbookReview({
  attemptId,
  initialQuestionIndex
}: {
  attemptId: string;
  initialQuestionIndex: number;
}) {
  const router = useRouter();
  const [review, setReview] = useState<StandardReview | FullSetReview | null>(null);
  const [error, setError] = useState("");
  const resultHref = `/student/reading/wrongbook-results/${encodeURIComponent(attemptId)}`;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { data: { session } } = await createBrowserSupabase().auth.getSession();
        if (!session) throw new Error("请先登录后再查看订正作答。");
        const response = await fetch(
          `/api/reading/wrongbook-attempts/${encodeURIComponent(attemptId)}/review`,
          { cache: "no-store", headers: { Authorization: `Bearer ${session.access_token}` } }
        );
        const payload = await response.json().catch(() => ({})) as Payload;
        if (!response.ok || payload.error || !payload.disclosures || !Array.isArray(payload.reviewItems)) {
          throw new Error(payload.error ?? "订正作答加载失败，请稍后重试。");
        }
        if (payload.fullSet) {
          const attempt = payload.attempt as unknown as { attemptId?: string; title?: string };
          if (attempt?.attemptId !== attemptId || typeof attempt.title !== "string" || !Array.isArray(payload.occurrences)) {
            throw new Error("这次订正作答暂时无法显示。");
          }
          if (!cancelled) setReview({
            attempt: { attemptId, title: attempt.title },
            disclosures: payload.disclosures,
            fullSet: true,
            occurrences: payload.occurrences,
            reviewItems: payload.reviewItems as FullSetReviewItem[]
          });
          return;
        }
        if (!payload.practice || !isReadingAttemptSummary(payload.attempt) || !payload.answers) {
          throw new Error(payload.error ?? "订正作答加载失败，请稍后重试。");
        }
        if (payload.attempt.status !== "submitted" || payload.attempt.attemptId !== attemptId) {
          throw new Error("这次订正作答暂时无法显示。");
        }
        if (!cancelled) setReview({
          answers: payload.answers,
          attempt: payload.attempt,
          disclosures: payload.disclosures,
          fullSet: false,
          practice: payload.practice,
          reviewItems: payload.reviewItems
        });
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "订正作答加载失败，请稍后重试。");
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [attemptId]);

  if (error) return <ReadingPracticeMessage description={error} onLeave={() => router.push(resultHref)} title="无法打开订正作答" />;
  if (!review) return <ReadingPracticeMessage description="正在加载订正作答..." title="正在准备订正结果" />;
  if (review.fullSet) {
    return <ReadingFullSetWrongbookReviewShell initialIndex={initialQuestionIndex} onBack={() => router.push(resultHref)} review={review} />;
  }
  return (
    <ReadingPracticeShell
      attempt={review.attempt}
      initialAnswers={review.answers}
      initialQuestionIndex={initialQuestionIndex}
      initialReviewIndex={initialQuestionIndex}
      mode="submitted_review"
      onBack={() => router.push(resultHref)}
      practice={review.practice}
      reviewDisclosureLabel="正确答案"
      reviewDisclosures={review.disclosures}
      reviewItems={review.reviewItems}
      reviewTitle="错题订正结果"
    />
  );
}

function ReadingFullSetWrongbookReviewShell({
  initialIndex,
  onBack,
  review
}: {
  initialIndex: number;
  onBack: () => void;
  review: FullSetReview;
}) {
  const [index, setIndex] = useState(() => Math.max(0, Math.min(review.reviewItems.length - 1, initialIndex)));
  const item = review.reviewItems[index] ?? review.reviewItems[0];
  const occurrence = item
    ? review.occurrences.find((candidate) => candidate.occurrenceId === item.occurrenceId)
    : null;
  const question = occurrence?.practice.questions.find((candidate) => candidate.questionId === item?.questionId);
  if (!item || !occurrence || !question) {
    return <ReadingPracticeMessage description="订正作答内容不完整。" onLeave={onBack} title="无法打开订正作答" />;
  }
  const sameQuestionItems = review.reviewItems.filter((candidate) =>
    candidate.occurrenceId === item.occurrenceId && candidate.questionId === item.questionId
  );
  const disclosure = review.disclosures[item.answerId];
  return (
    <div className="min-h-[100dvh] bg-[#fbfbfe] text-student-text">
      <header className="grid h-[76px] grid-cols-[1fr_auto_1fr] items-center border-b border-student-border bg-white px-5">
        <button className="writing-header-back justify-self-start" onClick={onBack} type="button"><ArrowLeft size={20} /> Back</button>
        <p className="max-w-[50vw] truncate text-sm font-bold text-student-primary">错题订正结果 · {review.attempt.title}</p>
        <span />
      </header>
      <main className="mx-auto flex min-h-[calc(100dvh-76px)] max-w-[1440px] flex-col px-4 py-4 sm:px-6 lg:px-8"
        style={occurrence.practice.item.module === "ctw" ? undefined : readingTwoColumnScaleStyle}>
        <section className="mb-3 rounded-2xl border border-student-border bg-white px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className={`text-sm font-bold ${item.isCorrect ? "text-student-primary" : "text-student-error"}`}>第{item.order}题 · {item.isCorrect ? "正确" : "错误"}</p>
            <div className="flex flex-wrap gap-1.5" aria-label="阅读作答题号导航">
              {review.reviewItems.map((candidate, candidateIndex) => <button
                className={`min-h-8 min-w-8 rounded-full border px-2 text-xs font-bold ${candidateIndex === index ? "border-amber-500 bg-amber-100" : candidate.isCorrect ? "border-student-primary-border bg-student-primary-soft text-student-primary" : "border-student-error-border bg-student-error-soft text-student-error"}`}
                key={candidate.answerId}
                onClick={() => setIndex(candidateIndex)}
                type="button">{candidate.order}</button>)}
            </div>
          </div>
          {disclosure ? <dl className="mt-3 grid gap-3 border-t border-student-border pt-3 text-sm leading-6 sm:grid-cols-2">
            <div><dt className="inline font-semibold text-student-muted">你的答案</dt><dd className="ml-2 inline font-semibold text-student-text">{disclosure.studentAnswer}</dd></div>
            <div><dt className="inline font-semibold text-student-muted">正确答案</dt><dd className="ml-2 inline font-semibold text-student-text"><ReadingCorrectionAnswerValue answer={disclosure.correctAnswer} /></dd></div>
          </dl> : null}
        </section>
        <section className={occurrence.practice.item.module === "ctw"
          ? "flex-1 rounded-2xl border border-student-border bg-white p-5 shadow-sm sm:p-7"
          : "flex flex-1 flex-col bg-white"}>
          <ReadingWorkspaceRouter
            answers={occurrence.answers}
            currentQuestion={question}
            lookupEnabled={readingLookupEnabled("submitted_review", occurrence.practice.item.module)}
            layoutMode="natural"
            onAnswerChange={() => undefined}
            practice={occurrence.practice}
            readOnly
            reviewPresentation={disclosure}
            reviewItems={sameQuestionItems}
            selectedReviewItem={item}
          />
        </section>
        <div className="mt-4 grid grid-cols-3 items-center gap-3">
          <button className="student-button-secondary justify-self-start" disabled={index === 0} onClick={() => setIndex(index - 1)} type="button"><ChevronLeft size={18} /> Previous</button>
          <span />
          <button className="student-button-primary justify-self-end" disabled={index === review.reviewItems.length - 1} onClick={() => setIndex(index + 1)} type="button">Next <ChevronRight size={18} /></button>
        </div>
      </main>
    </div>
  );
}
