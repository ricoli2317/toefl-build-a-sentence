"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useStudentCachedData, useStudentDataCache } from "@/components/StudentDataCache";
import { withStudentReturnTo } from "@/lib/studentNavigation";
import { loadCategoryCompletedReview, loadWrongbookCompletedReview, resolveSessionReviewBundle, restoreSessionReviewMaterials, sessionReviewBundleCacheKey,
  type CategoryCompletedReview, type WrongbookCompletedReview } from "@/lib/reading/sessionReviewBundle";
import { ReadingFullSetReviewShell, ReadingPracticeMessage } from "./ReadingPractice";
import { readReadingSessionPractice } from "@/lib/reading/sessionExperience";
import type { LexicalAccess } from "@/lib/lexical/lookup";

/** A ready result has already hydrated this key. On a fresh tab/refresh ONLY,
 * the same completed-session loader restores all metadata and missing material. */
export function ReadingSessionBundleReview({ kind, sessionId, initialReviewIndex, returnTo, lexicalAccess }: {
  kind: "category" | "wrongbook"; sessionId: string; initialReviewIndex: number; returnTo?: string | null; lexicalAccess?: LexicalAccess;
}) {
  const router = useRouter();
  const cache = useStudentDataCache();
  const cacheRef = useRef(cache); cacheRef.current = cache;
  const state = useStudentCachedData<CategoryCompletedReview | WrongbookCompletedReview>(sessionReviewBundleCacheKey(kind, sessionId),
    (auth) => kind === "category" ? loadCategoryCompletedReview(sessionId, cacheRef.current, auth)
      : loadWrongbookCompletedReview(sessionId, cacheRef.current, auth));
  const missingMaterial = state.data?.bundle.sources.some((source) => !readReadingSessionPractice(cache, source.practiceCacheKey)) ?? false;
  const recovering = useRef<ReadingSessionReviewBundleIdentity | null>(null);
  const [recoveryError, setRecoveryError] = useState("");
  useEffect(() => {
    if (!state.data || !missingMaterial || recovering.current === state.data.bundle) return;
    recovering.current = state.data.bundle;
    void restoreSessionReviewMaterials(state.data.bundle, cacheRef.current).catch((failure) => {
      setRecoveryError(failure instanceof Error ? failure.message : "阅读材料恢复失败，请刷新重试。");
    });
  }, [missingMaterial, state.data]);
  const base = kind === "category" ? `/student/question-category-practice/sessions/${encodeURIComponent(sessionId)}`
    : `/student/wrong-questions/sessions/${encodeURIComponent(sessionId)}`;
  const onBack = () => router.push(withStudentReturnTo(base, returnTo));
  if (state.error || recoveryError) return <ReadingPracticeMessage title="无法打开作答" description={state.error || recoveryError} onLeave={onBack} />;
  if (!state.data || missingMaterial) return <ReadingPracticeMessage title="正在恢复练习作答" description="正在恢复完整练习结果..." />;
  let payload;
  try {
    payload = resolveSessionReviewBundle(state.data.bundle, cache, (index) => withStudentReturnTo(`${base}/questions/${index}`, returnTo));
  } catch (failure) {
    return <ReadingPracticeMessage title="无法打开作答" description={failure instanceof Error ? failure.message : "作答详情不完整。"} onLeave={onBack} />;
  }
  return <ReadingFullSetReviewShell payload={payload} variant="session" initialSourceAnswerIndex={initialReviewIndex}
    lexicalAccess={lexicalAccess} onBack={onBack} />;
}

type ReadingSessionReviewBundleIdentity = CategoryCompletedReview["bundle"];
