"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  studentWrongQuestionsCacheKey,
  useStudentCachedData,
  useStudentDataCache,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  ReadingPracticePendingShell,
  ReadingPracticeShell
} from "@/components/reading/ReadingPractice";
import { STUDENT_ROUTES, withStudentReturnTo } from "@/lib/studentNavigation";
import type { ReadingAttemptSummary } from "@/lib/reading/attempts";
import type { StudentReadingPracticePayload } from "@/lib/reading/studentPractice";
import type { ReadingModule } from "@/lib/reading/types";
import type { WrongQuestionPracticeSession } from "@/lib/wrongQuestionBank";
import {
  buildReadingWrongbookInitialAnswers,
  isReadingWrongbookAttemptSummary,
  selectReadingWrongbookPractice,
  type ReadingWrongbookAttemptSummary,
  type ReadingWrongbookPracticeItem,
  type ReadingWrongbookPreservedAnswer
} from "@/lib/reading/wrongbook";

type SessionPayload = { error?: string; session?: WrongQuestionPracticeSession };
type AttemptPayload = {
  attempt?: unknown;
  error?: string;
  item?: ReadingWrongbookPracticeItem;
  preservedAnswers?: ReadingWrongbookPreservedAnswer[];
};
type PracticePayload = { error?: string; practice?: StudentReadingPracticePayload };
type EntryUnit = {
  attempt: ReadingWrongbookAttemptSummary;
  item: ReadingWrongbookPracticeItem;
  preservedAnswers: ReadingWrongbookPreservedAnswer[];
};

/**
 * Bank-driven Reading wrong-question practice:
 *   * today   - all currently pending questions of one task type
 *   * history - a frozen random session from the history bank
 *   * entry   - the wrong targets of one source attempt
 *
 * Only the current source is mounted; the next source is prefetched in the
 * background (content payload + at most one RDL image), and the session-level
 * timer keeps accumulating answerable time across sources.
 */
export function ReadingWrongbookBankPractice({
  amount,
  entryAttemptId,
  mode,
  returnTo,
  sessionId,
  taskType
}: {
  amount?: number;
  entryAttemptId?: string;
  mode: "entry" | "history" | "today";
  returnTo?: string | null;
  sessionId?: string;
  taskType: ReadingModule;
}) {
  const router = useRouter();
  const cache = useStudentDataCache();
  const isEntry = mode === "entry";
  const backHref = returnTo?.trim() || STUDENT_ROUTES.wrongQuestions;
  const manifestQuery = useMemo(() => {
    if (isEntry) return `entry:${taskType}:${entryAttemptId ?? ""}`;
    const params = new URLSearchParams({ mode, taskType });
    if (mode === "history" && amount) params.set("amount", String(amount));
    if (sessionId) params.set("sessionId", sessionId);
    return params.toString();
  }, [amount, entryAttemptId, isEntry, mode, sessionId, taskType]);

  const manifestState = useStudentCachedData<EntryUnit | SessionPayload>(
    studentWrongQuestionsCacheKey(`reading-bank:${mode}:${manifestQuery}`),
    (session) => isEntry
      ? loadEntryUnit(entryAttemptId ?? "", taskType, session)
      : loadBankSession(mode, taskType, manifestQuery, session),
    { enabled: isEntry ? Boolean(entryAttemptId) : true }
  );

  const entryUnit = isEntry ? manifestState.data as EntryUnit | null : null;
  const practiceSession = !isEntry ? (manifestState.data as SessionPayload | null)?.session ?? null : null;
  const serverSessionId = practiceSession?.sessionId ?? "";
  const groups = practiceSession?.groups ?? [];
  const totalPoints = useMemo(
    () => groups.reduce((sum, group) => sum + group.targets.length, 0),
    [groups]
  );
  const groupStarts = useMemo(() => {
    let offset = 0;
    return groups.map((group) => {
      const start = offset;
      offset += group.targets.length;
      return start;
    });
  }, [groups]);

  // The created session is pinned into the URL so refresh / back-navigation
  // resumes the exact same frozen draw (and never re-randomizes).
  useEffect(() => {
    if (isEntry || sessionId || !serverSessionId || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("session") === serverSessionId) return;
    url.searchParams.set("session", serverSessionId);
    window.history.replaceState(null, "", url.toString());
  }, [isEntry, serverSessionId, sessionId]);

  const [groupIndex, setGroupIndex] = useState<number | null>(null);
  useEffect(() => {
    if (isEntry || groupIndex !== null || !practiceSession || groups.length === 0) return;
    const pendingIndex = groups.findIndex(
      (group) => !practiceSession.progress?.[group.logicalItemId]
    );
    setGroupIndex(pendingIndex === -1 ? groups.length - 1 : pendingIndex);
  }, [groupIndex, groups, isEntry, practiceSession]);

  // A finished session jumps straight back to its result page.
  useEffect(() => {
    if (isEntry || !serverSessionId || !practiceSession || practiceSession.status !== "completed") {
      return;
    }
    router.replace(withStudentReturnTo(
      `/student/wrong-questions/sessions/${encodeURIComponent(serverSessionId)}`,
      returnTo
    ));
  }, [isEntry, practiceSession, returnTo, router, serverSessionId]);

  const group = !isEntry && groupIndex !== null ? groups[groupIndex] ?? null : null;

  const attemptState = useStudentCachedData<AttemptPayload>(
    studentWrongQuestionsCacheKey(`reading-bank-attempt:${serverSessionId}:${group?.logicalItemId ?? "none"}`),
    (session) => loadGroupAttempt(serverSessionId, group?.logicalItemId ?? "", session),
    { enabled: Boolean(group && serverSessionId) }
  );
  const practiceItemId = isEntry
    ? entryUnit?.item?.logicalItemId ?? ""
    : group?.logicalItemId ?? "";
  const practiceState = useStudentCachedData<PracticePayload>(
    studentWrongQuestionsCacheKey(`reading-correction-practice:${practiceItemId}`),
    (session) => loadPractice(practiceItemId, session),
    { enabled: Boolean(practiceItemId) }
  );

  const attempt = isEntry ? entryUnit?.attempt ?? null : attemptState.data?.attempt ?? null;
  const item = isEntry ? entryUnit?.item ?? null : attemptState.data?.item ?? null;
  const preservedAnswers = useMemo<ReadingWrongbookPreservedAnswer[]>(
    () => isEntry ? entryUnit?.preservedAnswers ?? [] : attemptState.data?.preservedAnswers ?? [],
    [attemptState.data?.preservedAnswers, entryUnit?.preservedAnswers, isEntry]
  );
  const ready = useMemo(() => {
    const rawPractice = practiceState.data?.practice;
    if (!rawPractice || !item || !attempt || !isReadingWrongbookAttemptSummary(attempt)) return null;
    const practice = selectReadingWrongbookPractice(rawPractice, item.targets);
    return {
      attempt,
      initialAnswers: buildReadingWrongbookInitialAnswers(practice, preservedAnswers),
      item,
      practice
    };
  }, [attempt, item, practiceState.data?.practice, preservedAnswers]);

  const [elapsedOffset, setElapsedOffset] = useState(0);
  const preloadedRef = useRef(new Set<string>());
  useEffect(() => {
    if (isEntry || !ready || !group || groupIndex === null) return;
    const next = groups[groupIndex + 1];
    if (!next) return;
    const key = studentWrongQuestionsCacheKey(`reading-correction-practice:${next.logicalItemId}`);
    if (preloadedRef.current.has(key)) return;
    preloadedRef.current.add(key);
    void cache.load(key, (session) => loadPractice(next.logicalItemId, session)).then((payload) => {
      // RDL: one next-material image at most, decoded by the browser cache.
      const imageUrl = payload?.practice?.material?.imageUrl;
      if (!imageUrl || typeof window === "undefined") return;
      const image = new window.Image();
      image.decoding = "async";
      image.src = imageUrl;
    });
  }, [cache, group, groupIndex, groups, isEntry, ready]);

  const progressLabelResolver = useMemo(() => {
    if (isEntry || !ready || !group || groupIndex === null) return undefined;
    const start = groupStarts[groupIndex] ?? 0;
    return (currentIndex: number) => ready.practice.item.module === "ctw"
      ? `第 ${start + 1}–${start + group.targets.length} / ${totalPoints} 题`
      : `第 ${start + currentIndex + 1} / ${totalPoints} 题`;
  }, [group, groupIndex, groupStarts, isEntry, ready, totalPoints]);

  const handleSubmitted = useCallback((submittedAttempt: ReadingAttemptSummary) => {
    if (isEntry) {
      router.replace(withStudentReturnTo(
        `/student/reading/wrongbook-results/${encodeURIComponent(submittedAttempt.attemptId)}`,
        returnTo
      ));
      return;
    }
    setElapsedOffset((offset) => offset + (submittedAttempt.elapsedSeconds ?? 0));
    if (groupIndex === null) return;
    if (groupIndex + 1 < groups.length) {
      setGroupIndex(groupIndex + 1);
      return;
    }
    if (serverSessionId) {
      router.replace(withStudentReturnTo(
        `/student/wrong-questions/sessions/${encodeURIComponent(serverSessionId)}`,
        returnTo
      ));
      return;
    }
    router.push(backHref);
  }, [backHref, groupIndex, groups.length, isEntry, returnTo, router, serverSessionId]);

  const pendingPreview = practiceState.data?.practice;
  const loadError = manifestState.error || attemptState.error || practiceState.error;
  if (loadError) {
    return (
      <BankMessage
        actionLabel="返回"
        description={loadError}
        onAction={() => router.push(backHref)}
        title="无法进入错题练习"
      />
    );
  }
  if (!ready && pendingPreview && (attemptState.loading || manifestState.loading)) {
    return (
      <ReadingPracticePendingShell
        onBack={() => router.push(backHref)}
        practice={pendingPreview}
        reviewTitle={mode === "today" ? "错题订正" : "历史错题练习"}
      />
    );
  }
  if (!ready) {
    return <BankMessage description="正在加载错题和原题练习界面..." title="正在准备错题练习" />;
  }

  return (
    <ReadingPracticeShell
      attempt={ready.attempt}
      elapsedOffsetSeconds={isEntry ? 0 : elapsedOffset}
      initialAnswers={ready.initialAnswers}
      key={ready.item.logicalItemId}
      onBack={() => router.push(backHref)}
      practice={ready.practice}
      progressLabelResolver={progressLabelResolver}
      resultReturnTo={returnTo}
      reviewTitle={`${mode === "today" ? "错题订正" : "历史错题练习"} · ${ready.item.title}`}
      wrongbook={{
        onSubmitted: handleSubmitted,
        sessionId: serverSessionId || undefined,
        targets: ready.item.targets
      }}
    />
  );
}

function BankMessage({
  actionLabel,
  description,
  onAction,
  title
}: {
  actionLabel?: string;
  description: string;
  onAction?: () => void;
  title: string;
}) {
  return (
    <main className="reading-theme flex min-h-screen items-center justify-center bg-[#fbfbfe] px-5">
      <section className="student-card w-full max-w-lg p-8 text-center">
        <h1 className="text-2xl font-bold text-student-text">{title}</h1>
        <p className="mt-3 text-sm leading-6 text-student-muted">{description}</p>
        {actionLabel && onAction ? (
          <button className="student-button-primary mt-6" onClick={onAction} type="button">
            {actionLabel}
          </button>
        ) : null}
      </section>
    </main>
  );
}

async function loadBankSession(
  mode: "entry" | "history" | "today",
  taskType: ReadingModule,
  query: string,
  session: StudentCacheSession
) {
  const params = new URLSearchParams(query);
  const existingSessionId = params.get("sessionId")?.trim() ?? "";
  const response = existingSessionId
    ? await fetch(`/api/wrong-questions/sessions/${encodeURIComponent(existingSessionId)}`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${session.accessToken}` }
      })
    : await fetch("/api/wrong-questions/sessions", {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: params.get("amount") ? Number(params.get("amount")) : null,
          mode,
          taskType
        })
      });
  const payload = await response.json().catch(() => ({})) as SessionPayload;
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? "错题练习加载失败，请稍后重试。");
  }
  if (
    !payload.session
    || payload.session.taskType !== taskType
    || !payload.session.groups
    || payload.session.groups.length === 0
  ) {
    throw new Error("错题练习数据无效。");
  }
  return payload;
}

async function loadEntryUnit(
  sourceAttemptId: string,
  taskType: ReadingModule,
  session: StudentCacheSession
): Promise<EntryUnit> {
  const response = await fetch("/api/reading/wrongbook-attempts", {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ mode: "entry", sourceAttemptId, taskType })
  });
  const payload = await response.json().catch(() => ({})) as AttemptPayload;
  if (!response.ok || payload.error || !payload.item || !isReadingWrongbookAttemptSummary(payload.attempt)) {
    throw new Error(payload.error ?? "错题订正加载失败，请稍后重试。");
  }
  return {
    attempt: payload.attempt,
    item: payload.item,
    preservedAnswers: payload.preservedAnswers ?? []
  };
}

async function loadGroupAttempt(
  sessionId: string,
  itemId: string,
  session: StudentCacheSession
) {
  const response = await fetch("/api/reading/wrongbook-attempts", {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ itemId, sessionId })
  });
  const payload = await response.json().catch(() => ({})) as AttemptPayload;
  if (!response.ok || payload.error || !payload.item || !isReadingWrongbookAttemptSummary(payload.attempt)) {
    throw new Error(payload.error ?? "错题订正记录加载失败，请稍后重试。");
  }
  return {
    attempt: payload.attempt,
    item: payload.item,
    preservedAnswers: payload.preservedAnswers ?? []
  };
}

async function loadPractice(itemId: string, session: StudentCacheSession) {
  const response = await fetch(`/api/reading/practice/${encodeURIComponent(itemId)}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as PracticePayload;
  if (!response.ok || !payload.practice || payload.practice.item.itemId !== itemId) {
    throw new Error(payload.error ?? "阅读错题内容加载失败，请稍后重试。");
  }
  return payload;
}
