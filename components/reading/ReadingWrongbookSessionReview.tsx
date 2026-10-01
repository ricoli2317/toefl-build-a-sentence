"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  studentWrongQuestionsCacheKey,
  useStudentCachedData,
  useStudentCachedValue,
  useStudentDataCache,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { isReadingAttemptSummary } from "@/lib/reading/attempts";
import {
  ReadingFullSetReviewShell,
  ReadingPracticeMessage,
  type ReadingReviewSourceStatus
} from "@/components/reading/ReadingPractice";
import type { ReadingCorrectionAnswerPresentation } from "@/lib/reading/correctionResult";
import type { ReadingModule } from "@/lib/reading/types";
import {
  buildSubmittedReadingAnswerState,
  buildSubmittedReadingReviewItems,
  type SubmittedReadingAnswerRow,
  type SubmittedReadingReviewPayload
} from "@/lib/reading/review";
import { selectReadingWrongbookPractice } from "@/lib/reading/wrongbook";
import {
  buildReadingWrongbookSessionReviewPayload,
  findReadingWrongbookSessionShapeIndex,
  readingWrongbookSessionShapeCacheKey,
  resolveReadingWrongbookSessionReviewShape,
  type ReadingWrongbookSessionReviewGroup,
  type ReadingWrongbookSessionReviewShape
} from "@/lib/reading/wrongbookSession";
import { withStudentReturnTo } from "@/lib/studentNavigation";
import type { StudentReadingPracticePayload } from "@/lib/reading/studentPractice";
import type { WrongQuestionPracticeSession, WrongQuestionSessionGroup } from "@/lib/wrongQuestionBank";
import type { ReadingWrongbookContextAnswer } from "@/lib/reading/wrongbook";

type SessionPayload = { error?: string; session?: WrongQuestionPracticeSession };
type ReviewPayload = Partial<SubmittedReadingReviewPayload> & {
  disclosures?: Record<string, ReadingCorrectionAnswerPresentation>;
  error?: string;
};
type LiteReviewPayload = {
  attempt?: unknown;
  contextAnswers?: ReadingWrongbookContextAnswer[];
  correctionRows?: SubmittedReadingAnswerRow[];
  disclosures?: Record<string, ReadingCorrectionAnswerPresentation>;
  error?: string;
  lite?: boolean;
  preservedRows?: SubmittedReadingAnswerRow[];
};
type PracticeCacheReader = {
  getEntry: (key: string) => { status: string; data?: unknown } | undefined;
};

type GroupReviewState =
  | { status: "error"; error: string }
  | { status: "loading" }
  | { status: "ready"; review: ReadingWrongbookSessionReviewGroup };

function isReadyGroupReview(
  state: GroupReviewState | undefined
): state is { status: "ready"; review: ReadingWrongbookSessionReviewGroup } {
  return state?.status === "ready";
}

/**
 * Session-global read-only review: every source's existing submitted review
 * concatenated in the frozen session order and rendered through the shared
 * multi-source reading review shell (same workspace, same disclosures, same
 * Previous / Next that steps across sources).
 *
 * Loading is source-first: the session manifest is reused from the result page
 * cache, the source that owns the opened question loads first and the shell
 * renders immediately (with exact global numbering for every source), while
 * the neighbouring sources are prefetched and any other source loads on demand
 * when it is opened. A single source failure never blanks the whole session.
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
  const cache = useStudentDataCache();
  // The cache context value changes on every notification, so callbacks that
  // write into it must not depend on the object identity.
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const selfBase = `/student/wrong-questions/sessions/${encodeURIComponent(sessionId)}`;
  const resultHref = withStudentReturnTo(selfBase, returnTo);

  const sessionState = useStudentCachedData<SessionPayload>(
    studentWrongQuestionsCacheKey(`reading-bank-result:${sessionId}`),
    (session) => loadSession(sessionId, session)
  );
  const session = sessionState.data?.session ?? null;
  const sessionError = sessionState.error || sessionState.data?.error || "";
  const sessionIsNotReading = Boolean(session) && session?.taskType === "bas";
  const groups = useMemo(() => session?.groups ?? [], [session]);
  const taskType: ReadingModule | null = session && session.taskType !== "bas"
    ? session.taskType
    : null;

  // The result page stores the exact per-source item counts of the rows it
  // loaded; read-only positions then exist before any per-source request.
  const cachedShape = useStudentCachedValue<ReadingWrongbookSessionReviewShape[]>(
    studentWrongQuestionsCacheKey(readingWrongbookSessionShapeCacheKey(sessionId))
  );
  const shape = useMemo(() => (
    session && taskType
      ? resolveReadingWrongbookSessionReviewShape({ cachedShape, groups, taskType })
      : null
  ), [cachedShape, groups, session, taskType]);

  const [groupStates, setGroupStates] = useState<Record<string, GroupReviewState>>({});
  const groupStatesRef = useRef(groupStates);
  groupStatesRef.current = groupStates;
  const inFlightRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const [legacyGroups, setLegacyGroups] = useState<ReadingWrongbookSessionReviewGroup[] | null>(null);
  const [legacyError, setLegacyError] = useState("");

  const loadGroup = useCallback(async (logicalItemId: string, retry = false) => {
    if (!logicalItemId) return;
    const current = groupStatesRef.current[logicalItemId];
    if (current?.status === "loading" || inFlightRef.current.has(logicalItemId)) return;
    if (current?.status === "ready") return;
    if (current?.status === "error" && !retry) return;
    const group = groups.find((candidate) => candidate.logicalItemId === logicalItemId);
    const progress = group ? session?.progress?.[group.logicalItemId] : null;
    if (!group || !progress) {
      const message = "这次练习还没有完成。";
      setGroupStates((states) => (
        states[logicalItemId]?.status === "error" && states[logicalItemId]?.error === message
          ? states
          : { ...states, [logicalItemId]: { status: "error", error: message } }
      ));
      return;
    }
    inFlightRef.current.add(logicalItemId);
    setGroupStates((states) => ({
      ...states,
      [logicalItemId]: { status: "loading" }
    }));
    try {
      // One submitted source review is immutable and cached per attempt, so a
      // second visit to the same source (or the same source of another review
      // entry) renders from memory instead of re-downloading the material.
      const reviewKey = studentWrongQuestionsCacheKey(`reading-bank-review:${progress.attemptId}`);
      const payload = await cacheRef.current.load<ReviewPayload>(
        reviewKey,
        (cacheSession) => loadGroupReview(
          progress.attemptId,
          group,
          cacheSession,
          cacheRef.current
        )
      );
      if (!payload) {
        const entry = cacheRef.current.getEntry(reviewKey);
        throw new Error(entry?.status === "error"
          ? entry.error
          : "订正作答加载失败，请稍后重试。");
      }
      if (!mountedRef.current) return;
      setGroupStates((states) => ({
        ...states,
        [logicalItemId]: {
          review: {
            group,
            payload: {
              answers: payload.answers!,
              attempt: payload.attempt!,
              disclosures: payload.disclosures!,
              practice: payload.practice!,
              reviewItems: payload.reviewItems!
            }
          },
          status: "ready"
        }
      }));
    } catch (failure) {
      if (!mountedRef.current) return;
      console.error("Reading session review source unavailable", {
        sessionId,
        logicalItemId,
        message: failure instanceof Error ? failure.message : "unknown"
      });
      setGroupStates((states) => ({
        ...states,
        [logicalItemId]: {
          error: failure instanceof Error ? failure.message : "订正作答加载失败，请稍后重试。",
          status: "error"
        }
      }));
    } finally {
      inFlightRef.current.delete(logicalItemId);
    }
  }, [groups, session, sessionId]);

  // Source-first loading: the opened question's source loads first, then its
  // two neighbours are prefetched. Every other source waits for navigation.
  useEffect(() => {
    if (!session || !taskType || !shape?.length) return;
    const groupIndex = findReadingWrongbookSessionShapeIndex(shape, initialReviewIndex);
    const requested = [
      shape[groupIndex],
      shape[groupIndex - 1],
      shape[groupIndex + 1]
    ];
    for (const entry of requested) {
      if (entry) void loadGroup(entry.logicalItemId);
    }
  }, [initialReviewIndex, loadGroup, session, shape, taskType]);

  // With the lite review (answers only — the material content and RDL assets
  // come from the practice's own cache) pulling the remaining sources one by
  // one after the opened one is cheap for every task type, so switching
  // materials never waits on a fresh request. Sequential by design: no request
  // bursts, and each source is fetched exactly once per page visit.
  const backgroundPrefetchRef = useRef("");
  useEffect(() => {
    if (!session || !taskType || !shape?.length) return;
    const runKey = `${sessionId}:${initialReviewIndex}`;
    if (backgroundPrefetchRef.current === runKey) return;
    backgroundPrefetchRef.current = runKey;
    let cancelled = false;
    void (async () => {
      const groupIndex = findReadingWrongbookSessionShapeIndex(shape, initialReviewIndex);
      const order = [
        ...shape.slice(groupIndex + 1),
        ...shape.slice(0, groupIndex)
      ].map((entry) => entry.logicalItemId);
      for (const logicalItemId of order) {
        if (cancelled) return;
        await loadGroup(logicalItemId);
      }
    })();
    return () => { cancelled = true; };
  }, [initialReviewIndex, loadGroup, session, sessionId, shape, taskType]);

  // No exact per-source counts (CTW opened without the result page, e.g. a
  // hard refresh): fall back to loading every source before rendering.
  useEffect(() => {
    if (!session || !taskType || shape) return;
    const sessionGroups = session.groups ?? [];
    if (sessionGroups.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data: { session: authSession } } = await createBrowserSupabase().auth.getSession();
        if (!authSession) throw new Error("请先登录后再查看订正作答。");
        const cacheSession = {
          accessToken: authSession.access_token,
          studentId: authSession.user.id
        };
        const loaded = await Promise.all(sessionGroups.map(async (group) => {
          const progress = session.progress[group.logicalItemId];
          if (!progress) throw new Error("这次练习还没有完成。");
          const payload = await loadGroupReview(
            progress.attemptId,
            group,
            cacheSession,
            cacheRef.current
          );
          return {
            group,
            payload: {
              answers: payload.answers!,
              attempt: payload.attempt!,
              disclosures: payload.disclosures!,
              practice: payload.practice!,
              reviewItems: payload.reviewItems!
            }
          };
        }));
        if (!cancelled) setLegacyGroups(loaded);
      } catch (failure) {
        if (!cancelled) {
          setLegacyError(failure instanceof Error ? failure.message : "订正作答加载失败，请稍后重试。");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [session, sessionId, shape, taskType]);

  if (sessionError) {
    return <ReadingPracticeMessage description={sessionError} onLeave={() => router.push(resultHref)} title="无法打开订正作答" />;
  }
  // An unfinished session has no review: rendering only the completed sources
  // would silently turn the session into a material-sized review. The student
  // continues the same session from the result page instead.
  if (
    session
    && (session.groups ?? []).some((group) => !session.progress?.[group.logicalItemId])
  ) {
    return (
      <ReadingPracticeMessage
        description="这次练习还没有完成。"
        leaveLabel="返回练习结果"
        onLeave={() => router.push(resultHref)}
        title="无法打开订正作答"
      />
    );
  }
  if (sessionIsNotReading) {
    return <ReadingPracticeMessage description="该练习不是阅读错题练习。" onLeave={() => router.push(resultHref)} title="无法打开订正作答" />;
  }
  if (!session || !taskType) {
    return <ReadingPracticeMessage description="正在加载订正作答..." title="正在准备订正结果" />;
  }
  if (!shape && legacyError) {
    return <ReadingPracticeMessage description={legacyError} onLeave={() => router.push(resultHref)} title="无法打开订正作答" />;
  }
  if (!shape && !legacyGroups) {
    return <ReadingPracticeMessage description="正在加载订正作答..." title="正在准备订正结果" />;
  }

  const loadedReviews: ReadingWrongbookSessionReviewGroup[] = shape
    ? groups.flatMap((group) => {
        const state = groupStates[group.logicalItemId];
        return isReadyGroupReview(state) ? [state.review] : [];
      })
    : legacyGroups ?? [];
  const payload = buildReadingWrongbookSessionReviewPayload({
    groupReviews: loadedReviews,
    reviewHref: (globalIndex) => withStudentReturnTo(`${selfBase}/questions/${globalIndex}`, returnTo),
    sessionId,
    shapes: shape,
    taskType,
    title: session.mode === "today" ? "今日错题订正" : "历史错题练习",
    // The session manifest already carries the whole-session elapsed time, so
    // the status bar shows the final number from the first render (never the
    // per-material time, and never a number that changes as sources load).
    totalElapsedSeconds: typeof session.elapsedSeconds === "number" ? session.elapsedSeconds : null
  });
  const sourceStatus: Record<string, ReadingReviewSourceStatus> = {};
  for (const group of groups) {
    const state = groupStates[group.logicalItemId];
    if (state?.status === "loading") sourceStatus[group.logicalItemId] = "loading";
    if (state?.status === "error") sourceStatus[group.logicalItemId] = "error";
  }

  return (
    <ReadingFullSetReviewShell
      initialSourceAnswerIndex={initialReviewIndex}
      onBack={() => router.push(resultHref)}
      onRequestItem={(item, options) => {
        void loadGroup(item.occurrenceId, options?.retry === true);
      }}
      payload={payload}
      sourceStatus={sourceStatus}
      variant="session"
    />
  );
}

async function loadSession(sessionId: string, session: StudentCacheSession) {
  const response = await fetch(
    `/api/wrong-questions/sessions/${encodeURIComponent(sessionId)}`,
    { cache: "no-store", headers: { Authorization: `Bearer ${session.accessToken}` } }
  );
  const payload = await response.json().catch(() => ({})) as SessionPayload;
  if (!response.ok || payload.error || !payload.session) {
    throw new Error(payload.error ?? "订正作答加载失败，请稍后重试。");
  }
  return payload;
}

/**
 * Reviews one source. When the practice's material payload is still cached —
 * the normal flow, since every source was practiced in this same SPA session —
 * only the answer data is fetched (`lite=1`) and the paragraph / assets come
 * from that cache, so switching sources never re-downloads material content
 * (nor RDL images). A missing cache (hard refresh / direct link) or an invalid
 * lite payload falls back to the full review request.
 */
async function loadGroupReview(
  attemptId: string,
  group: WrongQuestionSessionGroup,
  session: StudentCacheSession,
  cache: PracticeCacheReader
) {
  const cachedPractice = readCachedPractice(cache, group.logicalItemId);
  if (cachedPractice) {
    try {
      const response = await fetch(
        `/api/reading/wrongbook-attempts/${encodeURIComponent(attemptId)}/review?context=1&lite=1`,
        { cache: "no-store", headers: { Authorization: `Bearer ${session.accessToken}` } }
      );
      const payload = await response.json().catch(() => ({})) as LiteReviewPayload;
      if (
        !response.ok
        || payload.error
        || payload.lite !== true
        || !isReadingAttemptSummary(payload.attempt)
        || !Array.isArray(payload.correctionRows)
        || !Array.isArray(payload.preservedRows)
        || !payload.disclosures
      ) {
        throw new Error(payload.error ?? "订正作答数据无效。");
      }
      const practice = selectReadingWrongbookPractice(cachedPractice, group.targets);
      const correctionRows = payload.correctionRows;
      return {
        answers: buildSubmittedReadingAnswerState(
          practice,
          [...correctionRows, ...payload.preservedRows],
          {
            tolerateMissingCtwSlots: true,
            contextAnswers: payload.contextAnswers ?? []
          }
        ),
        attempt: payload.attempt,
        disclosures: payload.disclosures,
        practice,
        reviewItems: buildSubmittedReadingReviewItems(practice, correctionRows)
      } as ReviewPayload;
    } catch (liteError) {
      console.warn("Reading session review lite load failed; falling back to the full review", {
        attemptId,
        message: liteError instanceof Error ? liteError.message : "unknown"
      });
    }
  }
  return loadGroupReviewFull(attemptId, session);
}

function readCachedPractice(
  cache: PracticeCacheReader,
  logicalItemId: string
): StudentReadingPracticePayload | null {
  const entry = cache.getEntry(
    studentWrongQuestionsCacheKey(`reading-correction-practice:${logicalItemId}`)
  );
  if (!entry || !("data" in entry) || entry.status === "loading" || entry.status === "error") {
    return null;
  }
  const data = entry.data as { practice?: StudentReadingPracticePayload } | null | undefined;
  return data?.practice ?? null;
}

async function loadGroupReviewFull(attemptId: string, session: StudentCacheSession) {
  // `context=1` mirrors the history practice's read-only paragraph context for
  // untargeted CTW slots; the server only answers it for history sessions.
  const response = await fetch(
    `/api/reading/wrongbook-attempts/${encodeURIComponent(attemptId)}/review?context=1`,
    { cache: "no-store", headers: { Authorization: `Bearer ${session.accessToken}` } }
  );
  const payload = await response.json().catch(() => ({})) as ReviewPayload;
  if (
    !response.ok
    || payload.error
    || !payload.attempt
    || !payload.practice
    || !payload.answers
    || !payload.disclosures
    || !Array.isArray(payload.reviewItems)
  ) {
    console.error("Reading session review source load failed", {
      attemptId,
      status: response.status,
      reason: payload.error ?? "invalid payload"
    });
    throw new Error(payload.error ?? "订正作答加载失败，请稍后重试。");
  }
  return payload;
}
