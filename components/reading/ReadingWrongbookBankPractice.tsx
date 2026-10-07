"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  studentWrongQuestionsCacheKey, useStudentCachedData, useStudentDataCache, type StudentCacheSession
} from "@/components/StudentDataCache";
import { ReadingPracticeShell } from "./ReadingPractice";
import {
  ReadingMultiSourceSessionRunner, ReadingSessionMessage, loadReadingSessionPractice,
  type ReadingSessionAdapter
} from "./ReadingMultiSourceSessionRunner";
import { STUDENT_ROUTES, withStudentReturnTo } from "@/lib/studentNavigation";
import { type SubmittedReadingReviewPayload } from "@/lib/reading/review";
import type { ReadingModule } from "@/lib/reading/types";
import type { WrongQuestionPracticeSession } from "@/lib/wrongQuestionBank";
import {
  buildReadingWrongbookInitialAnswers, isReadingWrongbookAttemptSummary, selectReadingWrongbookPractice,
  type ReadingWrongbookAttemptSummary, type ReadingWrongbookContextAnswer,
  type ReadingWrongbookPracticeItem, type ReadingWrongbookPreservedAnswer
} from "@/lib/reading/wrongbook";
import { invalidateStudentWrongbook } from "@/lib/studentCacheEvents";

type SessionPayload = { error?: string; session?: WrongQuestionPracticeSession };
type AttemptPayload = {
  attempt?: unknown; contextAnswers?: ReadingWrongbookContextAnswer[]; error?: string;
  item?: ReadingWrongbookPracticeItem; preservedAnswers?: ReadingWrongbookPreservedAnswer[];
};
type EntryUnit = {
  attempt: ReadingWrongbookAttemptSummary; contextAnswers: ReadingWrongbookContextAnswer[];
  item: ReadingWrongbookPracticeItem; preservedAnswers: ReadingWrongbookPreservedAnswer[];
};
const readingSessionCreations = new Map<string, Promise<SessionPayload>>();

/** Business adapter only. Multi-source mechanics live in the shared runner. */
export function ReadingWrongbookBankPractice(props: {
  amount?: number; entryAttemptId?: string; mode: "entry" | "history" | "today";
  returnTo?: string | null; sessionId?: string; taskType: ReadingModule;
}) {
  return props.mode === "entry" ? <ReadingWrongbookEntryPractice {...props} /> : <ReadingWrongbookSessionPractice {...props} />;
}

function ReadingWrongbookSessionPractice({ amount, mode, returnTo, sessionId, taskType }: {
  amount?: number; mode: "entry" | "history" | "today"; returnTo?: string | null; sessionId?: string; taskType: ReadingModule;
}) {
  const router = useRouter();
  const cache = useStudentDataCache();
  const [pinnedSessionId, setPinnedSessionId] = useState("");
  const activeSessionId = sessionId ?? pinnedSessionId;
  const [entryNonce] = useState(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const manifestQuery = useMemo(() => {
    const params = new URLSearchParams({ mode, taskType });
    if (mode === "history" && amount) params.set("amount", String(amount));
    if (activeSessionId) params.set("sessionId", activeSessionId);
    else params.set("entry", entryNonce);
    return params.toString();
  }, [activeSessionId, amount, entryNonce, mode, taskType]);
  const manifestState = useStudentCachedData<SessionPayload>(
    studentWrongQuestionsCacheKey(`reading-bank:${mode}:${manifestQuery}`),
    (auth) => loadBankSession(mode, taskType, manifestQuery, auth)
  );
  const lastSessionRef = useRef<WrongQuestionPracticeSession | undefined>();
  if (manifestState.data?.session) lastSessionRef.current = manifestState.data.session;
  const practiceSession = manifestState.data?.session ?? lastSessionRef.current;
  const serverSessionId = practiceSession?.sessionId ?? "";
  const backHref = returnTo?.trim() || STUDENT_ROUTES.wrongQuestions;
  const resultHref = withStudentReturnTo(`/student/wrong-questions/sessions/${encodeURIComponent(serverSessionId)}`, returnTo);
  useEffect(() => {
    if (sessionId || !serverSessionId || pinnedSessionId === serverSessionId) return;
    const pinnedQuery = new URLSearchParams({ mode, taskType });
    if (mode === "history" && amount) pinnedQuery.set("amount", String(amount));
    pinnedQuery.set("sessionId", serverSessionId);
    cache.setData(studentWrongQuestionsCacheKey(`reading-bank:${mode}:${pinnedQuery}`), manifestState.data);
    setPinnedSessionId(serverSessionId);
    const url = new URL(window.location.href);
    url.searchParams.set("session", serverSessionId);
    window.history.replaceState(null, "", url.toString());
  }, [amount, cache, manifestState.data, mode, pinnedSessionId, serverSessionId, sessionId, taskType]);
  useEffect(() => {
    if (practiceSession?.status === "completed") router.replace(resultHref);
  }, [practiceSession?.status, resultHref, router]);
  const adapter = useMemo<ReadingSessionAdapter>(() => ({
    sourceCacheKey: (id, itemId) => studentWrongQuestionsCacheKey(`reading-bank-attempt:${id}:${itemId}`),
    practiceCacheKey: (itemId) => studentWrongQuestionsCacheKey(`reading-correction-practice:${itemId}`),
    loadSource: async (id, group, auth) => {
      const completed = lastSessionRef.current?.progress[group.logicalItemId];
      if (completed) {
        // On refresh + Previous, reuse the exact submitted correction. Never create another draft.
        const payload = await wrongbookFetch<SubmittedReadingReviewPayload>(
          `/api/reading/wrongbook-attempts/${encodeURIComponent(completed.attemptId)}/review?context=1`, auth
        );
        return { attempt: payload.attempt, initialAnswers: payload.answers };
      }
      const payload = await loadGroupAttempt(id, group.logicalItemId, auth);
      return {
        attempt: payload.attempt, initialAnswers: {},
        prepareAnswers: (practice) => buildReadingWrongbookInitialAnswers(practice, payload.preservedAnswers, payload.contextAnswers)
      };
    },
    submit: async ({ sessionId: id, group, source, answers, elapsedSeconds, auth }) => {
      const payload = await wrongbookFetch<AttemptPayload>(
        `/api/reading/wrongbook-attempts/${encodeURIComponent(source.attempt.attemptId)}/submit`, auth,
        { answers, elapsedSeconds, logicalItemId: group.logicalItemId, sessionId: id }
      );
      if (!isReadingWrongbookAttemptSummary(payload.attempt)) throw new Error("阅读提交结果无效。");
      if (lastSessionRef.current) {
        lastSessionRef.current = { ...lastSessionRef.current, progress: { ...lastSessionRef.current.progress,
          [group.logicalItemId]: { attemptId: payload.attempt.attemptId, correctPoints: payload.attempt.correctPoints,
            totalPoints: payload.attempt.totalPoints, submittedAt: payload.attempt.submittedAt! }
        } };
      }
      invalidateStudentWrongbook(auth.studentId);
      // Keep the controlled answer map, including untargeted CTW context.
      return { attempt: payload.attempt, initialAnswers: source.initialAnswers };
    }
  }), []);
  if (manifestState.error) return <ReadingSessionMessage title="无法进入错题练习" description={manifestState.error} onBack={() => router.push(backHref)} />;
  if (!practiceSession?.groups?.length) return <ReadingSessionMessage title="正在准备错题练习" description="正在加载错题和原题练习界面..." />;
  return <ReadingMultiSourceSessionRunner adapter={adapter} session={{ ...practiceSession, groups: practiceSession.groups }}
    title={mode === "today" ? "今日错题订正" : "历史错题练习"}
    onBack={() => router.push(backHref)} onCompleted={() => router.replace(resultHref)} />;
}

function ReadingWrongbookEntryPractice({ entryAttemptId, returnTo, taskType }: {
  entryAttemptId?: string; returnTo?: string | null; taskType: ReadingModule;
}) {
  const router = useRouter();
  const backHref = returnTo?.trim() || STUDENT_ROUTES.wrongQuestions;
  const entryState = useStudentCachedData<EntryUnit>(
    studentWrongQuestionsCacheKey(`reading-bank:entry:entry:${taskType}:${entryAttemptId ?? ""}`),
    (auth) => loadEntryUnit(entryAttemptId ?? "", taskType, auth), { enabled: Boolean(entryAttemptId) }
  );
  const itemId = entryState.data?.item.logicalItemId ?? "";
  const practiceState = useStudentCachedData(
    studentWrongQuestionsCacheKey(`reading-correction-practice:${itemId}`),
    (auth) => loadReadingSessionPractice(itemId, auth), { enabled: Boolean(itemId) }
  );
  const entryReady = useMemo(() => {
    if (!entryState.data || !practiceState.data?.practice) return null;
    const entry = entryState.data;
    const practice = selectReadingWrongbookPractice(practiceState.data.practice, entry.item.targets);
    return { ...entry, practice, initialAnswers: buildReadingWrongbookInitialAnswers(practice, entry.preservedAnswers, entry.contextAnswers) };
  }, [entryState.data, practiceState.data]);
  const error = entryState.error || practiceState.error;
  if (error) return <ReadingSessionMessage title="无法进入错题订正" description={error} onBack={() => router.push(backHref)} />;
  if (!entryReady) return <ReadingSessionMessage title="正在准备错题订正" description="正在加载错题和原题练习界面..." />;
  return <ReadingPracticeShell attempt={entryReady.attempt} initialAnswers={entryReady.initialAnswers}
    key={entryReady.item.logicalItemId} onBack={() => router.push(backHref)} practice={entryReady.practice}
    resultReturnTo={returnTo} reviewTitle="错题订正" wrongbook={{
      targets: entryReady.item.targets,
      onSubmitted: (submittedAttempt) => router.replace(withStudentReturnTo(
        `/student/reading/wrongbook-results/${encodeURIComponent(submittedAttempt.attemptId)}`, returnTo
      ))
    }} />;
}

async function wrongbookFetch<T>(url: string, auth: StudentCacheSession, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body ? "POST" : "GET", cache: "no-store",
    headers: { Authorization: `Bearer ${auth.accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error ?? "错题练习加载失败，请稍后重试。");
  return payload;
}
async function loadBankSession(mode: string, taskType: ReadingModule, query: string, auth: StudentCacheSession) {
  const params = new URLSearchParams(query);
  const existingSessionId = params.get("sessionId")?.trim();
  if (existingSessionId) return validateSession(await wrongbookFetch<SessionPayload>(
    `/api/wrong-questions/sessions/${encodeURIComponent(existingSessionId)}`, auth
  ), taskType);
  const key = `${auth.studentId}:${query}`;
  const inFlight = readingSessionCreations.get(key);
  if (inFlight) return inFlight;
  const creation = wrongbookFetch<SessionPayload>("/api/wrong-questions/sessions", auth, {
    amount: params.get("amount") ? Number(params.get("amount")) : null, mode, taskType
  }).then((payload) => validateSession(payload, taskType)).finally(() => readingSessionCreations.delete(key));
  readingSessionCreations.set(key, creation);
  return creation;
}
function validateSession(payload: SessionPayload, taskType: ReadingModule) {
  if (!payload.session || payload.session.taskType !== taskType || !payload.session.groups?.length) throw new Error("错题练习数据无效。");
  return payload;
}
function asEntry(payload: AttemptPayload): EntryUnit {
  if (!payload.item || !isReadingWrongbookAttemptSummary(payload.attempt)) throw new Error("错题订正数据无效。");
  return { attempt: payload.attempt, item: payload.item, contextAnswers: payload.contextAnswers ?? [], preservedAnswers: payload.preservedAnswers ?? [] };
}
async function loadEntryUnit(sourceAttemptId: string, taskType: ReadingModule, auth: StudentCacheSession) {
  return asEntry(await wrongbookFetch<AttemptPayload>("/api/reading/wrongbook-attempts", auth, { mode: "entry", sourceAttemptId, taskType }));
}
async function loadGroupAttempt(sessionId: string, itemId: string, auth: StudentCacheSession) {
  return asEntry(await wrongbookFetch<AttemptPayload>("/api/reading/wrongbook-attempts", auth, { itemId, sessionId }));
}
