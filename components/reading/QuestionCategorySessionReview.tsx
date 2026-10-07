"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { withStudentReturnTo } from "@/lib/studentNavigation";
import { useStudentCachedData, useStudentDataCache } from "@/components/StudentDataCache";
import { ReadingFullSetReviewShell, type ReadingReviewSourceStatus } from "./ReadingPractice";
import { ReadingSessionMessage, loadReadingSessionPractice } from "./ReadingMultiSourceSessionRunner";
import { categorySessionCacheKey, categoryPracticeCacheKey, categoryGroupUrl, categoryFetch, loadCategorySession } from "@/lib/reading/questionCategory.client";
import { categoryResultAnswers, categoryResultHref, categorySessionTitle } from "@/lib/reading/questionCategory";
import { selectReadingTargetPractice } from "@/lib/reading/wrongbook";
import { buildSubmittedReadingAnswerState, buildSubmittedReadingReviewItems, type SubmittedReadingAnswerRow } from "@/lib/reading/review";
import type { ReadingCorrectionAnswerPresentation } from "@/lib/reading/correctionResult";
import { buildReadingWrongbookSessionReviewPayload, findReadingWrongbookSessionShapeIndex, type ReadingWrongbookSessionReviewGroup } from "@/lib/reading/wrongbookSession";

export function QuestionCategorySessionReview({ sessionId, initialReviewIndex, returnTo }: {
  sessionId: string; initialReviewIndex: number; returnTo?: string | null;
}) {
  const router = useRouter();
  const cache = useStudentDataCache();
  const cacheRef = useRef(cache); cacheRef.current = cache;
  const state = useStudentCachedData(categorySessionCacheKey(sessionId), (auth) => loadCategorySession(sessionId, auth));
  const session = state.data?.session;
  const [reviews, setReviews] = useState<Record<string, ReadingWrongbookSessionReviewGroup>>({});
  const [statuses, setStatuses] = useState<Record<string, ReadingReviewSourceStatus>>({});
  const started = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const shape = useMemo(() => {
    if (!state.data || state.data.session.status !== "completed") return [];
    const ordered = categoryResultAnswers(state.data.session, state.data.answers);
    return state.data.session.groups.map((group) => ({ logicalItemId: group.logicalItemId, itemCount: group.targets.length,
      items: ordered.filter((answer) => answer.logicalItemId === group.logicalItemId) }));
  }, [state.data]);
  const loadGroup = useCallback(async (itemId: string, retry = false) => {
    if (!session || session.status !== "completed" || (started.current.has(itemId) && !retry)) return;
    const group = session.groups.find((group) => group.logicalItemId === itemId);
    if (!group) return;
    started.current.add(itemId);
    setStatuses((current) => ({ ...current, [itemId]: "loading" }));
    try {
      const payload = await cacheRef.current.load<ReadingWrongbookSessionReviewGroup>(`reading:category-review:${sessionId}:${itemId}`, async (auth) => {
        const [content, lite] = await Promise.all([
          cacheRef.current.load(categoryPracticeCacheKey(itemId), (auth) => loadReadingSessionPractice(itemId, auth)),
          categoryFetch<{ rows: SubmittedReadingAnswerRow[]; disclosures: Record<string, ReadingCorrectionAnswerPresentation> }>(`${categoryGroupUrl(sessionId, itemId)}/review`, auth)
        ]);
        if (!content) throw new Error("阅读材料加载失败，请稍后重试。");
        const practice = selectReadingTargetPractice(content.practice, group.targets);
        return { group, payload: {
          practice, attempt: { attemptId: sessionId, elapsedSeconds: session.progress[itemId].elapsedSeconds },
          answers: buildSubmittedReadingAnswerState(practice, lite.rows),
          reviewItems: buildSubmittedReadingReviewItems(practice, lite.rows), disclosures: lite.disclosures
        } };
      });
      if (!payload) throw new Error("阅读作答加载失败，请稍后重试。");
      if (mounted.current) { setReviews((current) => ({ ...current, [itemId]: payload })); setStatuses((current) => {
        const next = { ...current }; delete next[itemId]; return next;
      }); }
    } catch {
      if (mounted.current) setStatuses((current) => ({ ...current, [itemId]: "error" }));
    }
  }, [session, sessionId]);
  useEffect(() => {
    if (!shape.length) return;
    const index = findReadingWrongbookSessionShapeIndex(shape, initialReviewIndex);
    void loadGroup(shape[index].logicalItemId);
    if (shape[index + 1]) void loadGroup(shape[index + 1].logicalItemId);
    // Every other source waits for navigation, including hard refresh/direct links.
  }, [shape, initialReviewIndex, loadGroup]);
  const selfBase = categoryResultHref(sessionId);
  const selfPath = withStudentReturnTo(selfBase, returnTo);
  if (state.error || (session && session.status !== "completed")) return <ReadingSessionMessage title="无法打开作答"
    description={state.error || "这次练习还没有完成。"} onBack={() => router.push(selfPath)} />;
  if (!session) return <ReadingSessionMessage title="正在准备作答" description="正在加载练习结果..." />;
  const payload = buildReadingWrongbookSessionReviewPayload({
    groupReviews: session.groups.flatMap((group) => reviews[group.logicalItemId] ? [reviews[group.logicalItemId]] : []),
    shapes: shape, sessionId, title: categorySessionTitle(session.questionCategory), taskType: "rap",
    totalElapsedSeconds: session.elapsedSeconds, reviewHref: (index) => withStudentReturnTo(`${selfBase}/questions/${index}`, returnTo)
  });
  return <ReadingFullSetReviewShell payload={payload} variant="session" initialSourceAnswerIndex={initialReviewIndex}
    lexicalAccess={{ kind: "reading_category", attemptId: sessionId }}
    onBack={() => router.push(selfPath)} sourceStatus={statuses}
    onRequestItem={(item, options) => { void loadGroup(item.occurrenceId, options?.retry === true); }} />;
}
