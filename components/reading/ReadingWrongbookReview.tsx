"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { isReadingAttemptSummary } from "@/lib/reading/attempts";
import type { ReadingCorrectionAnswerPresentation } from "@/lib/reading/correctionResult";
import type { SubmittedReadingReviewPayload } from "@/lib/reading/review";
import { ReadingPracticeMessage, ReadingPracticeShell } from "./ReadingPractice";

type Payload = Partial<SubmittedReadingReviewPayload> & {
  disclosures?: Record<string, ReadingCorrectionAnswerPresentation>;
  error?: string;
};

export function ReadingWrongbookReview({
  attemptId,
  initialQuestionIndex
}: {
  attemptId: string;
  initialQuestionIndex: number;
}) {
  const router = useRouter();
  const [review, setReview] = useState<(SubmittedReadingReviewPayload & {
    disclosures: Record<string, ReadingCorrectionAnswerPresentation>;
  }) | null>(null);
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
        if (
          !response.ok || payload.error || !payload.practice
          || !isReadingAttemptSummary(payload.attempt) || !payload.answers
          || !Array.isArray(payload.reviewItems) || !payload.disclosures
        ) throw new Error(payload.error ?? "订正作答加载失败，请稍后重试。");
        if (payload.attempt.status !== "submitted" || payload.attempt.attemptId !== attemptId) {
          throw new Error("这次订正作答暂时无法显示。");
        }
        if (!cancelled) setReview({
          answers: payload.answers,
          attempt: payload.attempt,
          disclosures: payload.disclosures,
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
