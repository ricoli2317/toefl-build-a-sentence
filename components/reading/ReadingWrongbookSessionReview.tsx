"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  ReadingFullSetReviewShell,
  ReadingPracticeMessage
} from "@/components/reading/ReadingPractice";
import type { ReadingCorrectionAnswerPresentation } from "@/lib/reading/correctionResult";
import type { ReadingModule } from "@/lib/reading/types";
import type { SubmittedReadingReviewPayload } from "@/lib/reading/review";
import {
  buildReadingWrongbookSessionReviewPayload,
  type ReadingWrongbookSessionReviewGroup
} from "@/lib/reading/wrongbookSession";
import { withStudentReturnTo } from "@/lib/studentNavigation";
import type { WrongQuestionPracticeSession } from "@/lib/wrongQuestionBank";

type SessionPayload = { error?: string; session?: WrongQuestionPracticeSession };
type ReviewState =
  | { status: "error"; error: string }
  | { status: "ready"; groups: ReadingWrongbookSessionReviewGroup[] }
  | null;

/**
 * Session-global read-only review: every source's existing submitted review
 * concatenated in the frozen session order and rendered through the shared
 * multi-source reading review shell (same workspace, same disclosures, same
 * Previous / Next that steps across sources).
 */
export function ReadingWrongbookSessionReview({
  initialReviewIndex,
  returnTo,
  sessionId
}: {
  initialReviewIndex: number;
  returnTo?: string | null;
  sessionId: string;
}) {
  const router = useRouter();
  const [session, setSession] = useState<WrongQuestionPracticeSession | null>(null);
  const [taskType, setTaskType] = useState<ReadingModule | null>(null);
  const [review, setReview] = useState<ReviewState>(null);
  const [error, setError] = useState("");
  const selfBase = `/student/wrong-questions/sessions/${encodeURIComponent(sessionId)}`;
  const resultHref = withStudentReturnTo(selfBase, returnTo);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data: { session: authSession } } = await createBrowserSupabase().auth.getSession();
        if (!authSession) throw new Error("请先登录后再查看订正作答。");
        const sessionResponse = await fetch(
          `/api/wrong-questions/sessions/${encodeURIComponent(sessionId)}`,
          { cache: "no-store", headers: { Authorization: `Bearer ${authSession.access_token}` } }
        );
        const sessionPayload = await sessionResponse.json().catch(() => ({})) as SessionPayload;
        if (!sessionResponse.ok || sessionPayload.error || !sessionPayload.session) {
          throw new Error(sessionPayload.error ?? "订正作答加载失败，请稍后重试。");
        }
        if (sessionPayload.session.taskType === "bas") {
          throw new Error("该练习不是阅读错题练习。");
        }
        if (cancelled) return;
        setSession(sessionPayload.session);
        setTaskType(sessionPayload.session.taskType);
        const groups = sessionPayload.session.groups ?? [];
        const groupReviews = await Promise.all(groups.map(async (group) => {
          const progress = sessionPayload.session!.progress[group.logicalItemId];
          if (!progress) throw new Error("这次练习还没有完成。");
          const response = await fetch(
            `/api/reading/wrongbook-attempts/${encodeURIComponent(progress.attemptId)}/review`,
            { cache: "no-store", headers: { Authorization: `Bearer ${authSession.access_token}` } }
          );
          const payload = await response.json().catch(() => ({})) as
            Partial<SubmittedReadingReviewPayload>
            & { disclosures?: Record<string, ReadingCorrectionAnswerPresentation>; error?: string };
          if (
            !response.ok
            || payload.error
            || !payload.attempt
            || !payload.practice
            || !payload.answers
            || !payload.disclosures
            || !Array.isArray(payload.reviewItems)
          ) {
            throw new Error(payload.error ?? "订正作答加载失败，请稍后重试。");
          }
          return {
            group,
            payload: {
              answers: payload.answers,
              attempt: payload.attempt,
              disclosures: payload.disclosures,
              practice: payload.practice,
              reviewItems: payload.reviewItems
            }
          };
        }));
        if (!cancelled) setReview({ status: "ready", groups: groupReviews });
      } catch (failure) {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : "订正作答加载失败，请稍后重试。");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId]);

  if (error) {
    return <ReadingPracticeMessage description={error} onLeave={() => router.push(resultHref)} title="无法打开订正作答" />;
  }
  if (!session || !taskType || !review) {
    return <ReadingPracticeMessage description="正在加载订正作答..." title="正在准备订正结果" />;
  }
  if (review.status === "error") {
    return <ReadingPracticeMessage description={review.error} onLeave={() => router.push(resultHref)} title="无法打开订正作答" />;
  }

  const payload = buildReadingWrongbookSessionReviewPayload({
    groupReviews: review.groups,
    reviewHref: (globalIndex) => withStudentReturnTo(`${selfBase}/questions/${globalIndex}`, returnTo),
    sessionId,
    taskType,
    title: session.mode === "today" ? "今日错题订正" : "历史错题练习"
  });
  return (
    <ReadingFullSetReviewShell
      correctionReturnTo={resultHref}
      initialSourceAnswerIndex={initialReviewIndex}
      onBack={() => router.push(resultHref)}
      payload={payload}
      variant="session"
    />
  );
}
