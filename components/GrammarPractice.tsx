"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Clock3, ListChecks } from "lucide-react";
import { usePracticeHistory } from "@/components/PracticeHistory";
import {
  PracticeSession,
  type PracticeProgressSnapshot
} from "@/components/PracticeSession";
import {
  StudentEmptyState,
  StudentErrorState,
  StudentInfoStrip,
  StudentLoadingState,
  StudentNavigation
} from "@/components/student/StudentUI";
import {
  STUDENT_GRAMMAR_PRACTICE_CACHE_PREFIX,
  useStudentCachedData,
  useStudentDataCache,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  StudentEntitlementNotice,
  useStudentPracticeEntitlements
} from "@/components/student/StudentPracticeEntitlements";
import {
  GRAMMAR_PRACTICE_TIME_SECONDS,
  type GrammarPracticeDraft,
  type GrammarPracticeSessionPayload,
  type GrammarTagSummary
} from "@/lib/grammarPractice";
import { createClientRequestId } from "@/lib/clientRequestId";
import { STUDENT_PRACTICE_ENTITLEMENTS_CACHE_KEY } from "@/lib/practiceEntitlements";
import {
  loadGrammarPracticeSession,
  saveGrammarPracticeSessionDraft,
  startGrammarCategoryAssignmentSession,
  startGrammarPracticeSession
} from "@/lib/grammarPractice.client";
import { STUDENT_ROUTES, withStudentReturnTo } from "@/lib/studentNavigation";
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";
import type { PublicQuestion } from "@/lib/types";
import { BasGrammarAnalysis } from "@/components/WrongQuestionsHome";

export type GrammarTagsPayload = {
  error?: string;
  tags?: GrammarTagSummary[];
};

type GrammarQuestionsPayload = {
  count?: number;
  error?: string;
  questions?: PublicQuestion[];
  tag?: string;
};

const GRAMMAR_RANDOM_TIME_SECONDS = GRAMMAR_PRACTICE_TIME_SECONDS;
const GRAMMAR_TAG_ORDER = [
  "简单句－陈述句",
  "简单句－疑问句",
  "复杂句－陈述句－宾语从句",
  "复杂句－陈述句－定语从句",
  "复杂句－陈述句－状语从句",
  "复杂句－陈述句－表语从句",
  "复杂句－疑问句－宾语从句",
  "复杂句－疑问句－定语从句",
  "复杂句－疑问句－状语从句",
  "复杂句－疑问句－表语从句",
  "其他－并列句",
  "其他－后置定语",
  "其他－混合从句",
  "省略句"
] as const;

const GRAMMAR_TAG_PRIORITY: ReadonlyMap<string, number> = new Map(
  GRAMMAR_TAG_ORDER.map((tag, index) => [tag, index])
);

export function GrammarPracticeHome() {
  const { data, error, loading } = useGrammarTags();
  const historyState = usePracticeHistory();
  const entitlements = useStudentPracticeEntitlements();
  const sortedTags = useMemo(() => sortGrammarTags(data?.tags ?? []), [data?.tags]);
  const grammarPoints = historyState.data?.history.grammarPoints;
  const exhausted = entitlements.exhausted("bas_category");
  const showAllPractice = !(
    entitlements.viewerRole === "student" && entitlements.enforcementEnabled
  );

  return (
    <div className="grid gap-5">
      <GrammarNavigation />
      <StudentEntitlementNotice kind="bas_category" />
      {grammarPoints ? (
        <BasGrammarAnalysis items={grammarPoints} showLinks={false} tone="orange" />
      ) : null}
      <StudentInfoStrip>选择语法点开始练习，系统会使用该分类下的题目生成练习。</StudentInfoStrip>
      {loading ? <StudentLoadingState text="正在加载语法点..." /> : null}
      {error ? <StudentErrorState text="加载语法点失败，请稍后重试。" /> : null}
      {!loading && !error ? (
        sortedTags.length === 0 ? (
          <StudentEmptyState text="暂无可练习的语法标签。" />
        ) : (
          <div className="grid gap-2">
            {sortedTags.map((item) => (
              <GrammarPracticeRow
                exhausted={exhausted}
                key={item.tag}
                label={item.tag}
                questionCount={item.questionCount}
                showAllPractice={showAllPractice}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

function GrammarPracticeRow({
  exhausted,
  label,
  questionCount,
  showAllPractice
}: {
  exhausted: boolean;
  label: string;
  questionCount: number;
  showAllPractice: boolean;
}) {
  return (
    <article className={`grid min-h-[58px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-xl border border-student-border bg-white px-4 py-3 shadow-[0_1px_2px_rgba(23,32,51,0.025)] sm:px-5 lg:gap-x-3 lg:py-2 ${showAllPractice ? "lg:grid-cols-[minmax(0,1fr)_5.5rem_10rem_12rem]" : "lg:grid-cols-[minmax(0,1fr)_5.5rem_10rem]"}`}>
      <div className="flex min-w-0 items-center gap-3">
        <BookOpen
          aria-hidden="true"
          className="shrink-0 text-student-primary"
          size={23}
          strokeWidth={1.9}
        />
        <h2 className="min-w-0 text-[16px] font-semibold leading-6 text-student-text sm:text-[17px]">
          {label}
        </h2>
      </div>
      <p className="text-right text-[15px] font-medium tabular-nums text-student-muted lg:pr-2">
        {questionCount}题
      </p>
      <div className={`col-span-2 grid gap-2 lg:contents ${showAllPractice ? "grid-cols-2" : "grid-cols-1"}`}>
        {showAllPractice ? (
          <GrammarAction href={practiceHref(label, "all")} icon={ListChecks} label="全部练习" />
        ) : null}
        <GrammarRandomAction disabled={exhausted} tag={label} />
      </div>
    </article>
  );
}

function GrammarRandomAction({ disabled, tag }: { disabled: boolean; tag: string }) {
  const router = useRouter();
  const pendingStart = useRef<{ tag: string; requestId: string } | null>(null);

  function startRandomPractice() {
    if (disabled) return;
    if (pendingStart.current?.tag !== tag) {
      pendingStart.current = { tag, requestId: createClientRequestId() };
    }
    router.push(practiceHref(tag, "random", pendingStart.current.requestId));
    // Keep the same idempotency key for an accidental double click, but let a
    // deliberate later return to this page start a genuinely new session.
    window.setTimeout(() => {
      pendingStart.current = null;
    }, 1500);
  }

  return (
    <button
      className={`inline-flex min-h-9 min-w-0 items-center justify-center gap-2 rounded-[10px] bg-student-primary-soft px-3 py-1.5 text-sm font-semibold text-student-primary transition hover:bg-student-primary-border ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
      disabled={disabled}
      onClick={startRandomPractice}
      title={disabled ? "自主分类练习次数已用完，已有练习仍可继续。" : undefined}
      type="button"
    >
      <Clock3 aria-hidden="true" className="shrink-0" size={19} strokeWidth={1.9} />
      <span className="whitespace-nowrap">{disabled ? "自主练习次数已用完" : "随机计时练习"}</span>
    </button>
  );
}

function GrammarAction({
  href,
  icon: Icon,
  label
}: {
  href: string;
  icon: typeof ListChecks;
  label: string;
}) {
  return (
    <Link
      className="inline-flex min-h-9 min-w-0 items-center justify-center gap-2 rounded-[10px] bg-student-primary-soft px-3 py-1.5 text-sm font-semibold text-student-primary transition hover:bg-student-primary-border"
      href={href}
    >
      <Icon aria-hidden="true" className="shrink-0" size={19} strokeWidth={1.9} />
      <span className="whitespace-nowrap">{label}</span>
    </Link>
  );
}

function practiceHref(tag: string, mode: "all" | "random", requestId?: string) {
  const params = new URLSearchParams({ mode, tag });
  if (mode === "random" && requestId) params.set("requestId", requestId);
  return `${STUDENT_ROUTES.grammarPractice}/practice?${params.toString()}`;
}

function sortGrammarTags(tags: GrammarTagSummary[]) {
  return tags
    .map((tag, index) => ({ tag, index }))
    .sort((left, right) => {
      const leftPriority = grammarTagPriority(left.tag.tag);
      const rightPriority = grammarTagPriority(right.tag.tag);
      return (
        leftPriority - rightPriority ||
        (leftPriority === GRAMMAR_TAG_ORDER.length
          ? left.tag.tag.localeCompare(right.tag.tag, "zh-CN")
          : left.index - right.index)
      );
    })
    .map(({ tag }) => tag);
}

function grammarTagPriority(tag: string) {
  return GRAMMAR_TAG_PRIORITY.get(normalizeGrammarTagForSort(tag)) ?? GRAMMAR_TAG_ORDER.length;
}

function normalizeGrammarTagForSort(tag: string) {
  return tag
    .trim()
    .replace(/[\-‐‑‒–—―−]/g, "－")
    .replace(/\s*－\s*/g, "－")
    .replace(/\s+/g, " ");
}

export function GrammarQuestionsPractice({
  mode,
  tag,
  sessionId,
  requestId
}: {
  mode: "all" | "random";
  tag: string;
  sessionId?: string;
  requestId?: string;
}) {
  if (mode === "random") {
    return (
      <GrammarRandomSessionPractice
        tag={tag}
        sessionId={sessionId}
        requestId={requestId}
      />
    );
  }
  return <GrammarAllPractice tag={tag} />;
}

function GrammarAllPractice({ tag }: { tag: string }) {
  const practiceSessionKey = useMemo(
    () => `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    []
  );
  const query = useMemo(
    () => new URLSearchParams({ mode: "all", tag }).toString(),
    [tag]
  );
  const { data, error, loading } = useStudentCachedData<GrammarQuestionsPayload>(
    `${STUDENT_GRAMMAR_PRACTICE_CACHE_PREFIX}:session:${practiceSessionKey}`,
    (session) => loadGrammarPractice(query, session)
  );
  const questions = data?.questions ?? [];
  const virtualSetId = useMemo(
    () => `grammar-all-${formatTimestamp(new Date())}`,
    []
  );

  if (loading) return <StudentLoadingState text="正在加载语法练习..." />;
  if (error) return <StudentErrorState text="加载语法练习失败，请稍后重试。" />;
  if (!tag || questions.length === 0) {
    return (
      <div className="grid gap-5">
        <GrammarNavigation tag={tag || undefined} />
        <StudentEmptyState text="该语法标签暂无可练习题目，无法开始练习。" />
      </div>
    );
  }

  return (
    <PracticeSession
      allowEndPractice
      hideQuestionCardNumber
      initialQuestions={questions}
      setId={virtualSetId}
      setTitle={`Grammar Practice · ${tag}`}
      submitAnsweredOnly
      timed={false}
      totalSeconds={GRAMMAR_RANDOM_TIME_SECONDS}
    />
  );
}

export function GrammarCategoryAssignmentPractice({
  assignmentId,
  initialSessionId,
  requestId,
  returnTo
}: {
  assignmentId: string;
  initialSessionId?: string;
  requestId?: string;
  returnTo?: string | null;
}) {
  return (
    <GrammarRandomSessionPractice
      assignmentId={assignmentId}
      requestId={requestId}
      returnTo={returnTo}
      sessionId={initialSessionId}
      tag=""
    />
  );
}

function GrammarRandomSessionPractice({
  assignmentId,
  tag,
  sessionId,
  requestId,
  returnTo
}: {
  assignmentId?: string;
  tag: string;
  sessionId?: string;
  requestId?: string;
  returnTo?: string | null;
}) {
  const router = useRouter();
  const cache = useStudentDataCache();
  const [effectiveRequestId] = useState(
    () => requestId || createClientRequestId()
  );
  const revisionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const positiveTimer = Boolean(assignmentId);
  const cacheKey = `${STUDENT_GRAMMAR_PRACTICE_CACHE_PREFIX}:${assignmentId ? "assignment" : "random"}:${sessionId ?? assignmentId ?? effectiveRequestId}`;
  const { data, error, loading } = useStudentCachedData<GrammarPracticeSessionPayload>(
    cacheKey,
    (auth) =>
      sessionId
        ? loadGrammarPracticeSession(sessionId, auth)
        : assignmentId
          ? startGrammarCategoryAssignmentSession(assignmentId, effectiveRequestId, auth)
          : startGrammarPracticeSession(tag, effectiveRequestId, auth),
    { enabled: Boolean(tag || assignmentId), refreshOnMount: Boolean(sessionId) }
  );
  const session = data?.session;

  useEffect(() => {
    if (data?.created && !assignmentId) {
      cache.invalidate(STUDENT_PRACTICE_ENTITLEMENTS_CACHE_KEY);
    }
  }, [assignmentId, cache, data?.created]);

  useEffect(() => {
    if (error && /额度已用完/.test(error)) {
      cache.invalidate(STUDENT_PRACTICE_ENTITLEMENTS_CACHE_KEY);
    }
  }, [cache, error]);

  useEffect(() => {
    if (session?.draft?.revision) {
      revisionRef.current = Math.max(
        revisionRef.current,
        Number(session.draft.revision) || 0
      );
    }
  }, [session?.draft?.revision]);

  useEffect(() => {
    if (!session || sessionId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("session", session.sessionId);
    url.searchParams.delete("requestId");
    url.searchParams.delete("new");
    window.history.replaceState(null, "", url.toString());
  }, [session, sessionId]);

  useEffect(() => {
    if (sessionId || requestId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("requestId", effectiveRequestId);
    window.history.replaceState(null, "", url.toString());
  }, [effectiveRequestId, requestId, sessionId]);

  useEffect(() => {
    if (session?.status === "completed" && session.attemptId) {
      router.replace(withStudentReturnTo(
        `/student/results/${encodeURIComponent(session.attemptId)}`,
        returnTo
      ));
    }
  }, [returnTo, router, session?.attemptId, session?.status]);

  const handleProgress = useCallback(
    (snapshot: PracticeProgressSnapshot) => {
      if (!session || session.status !== "active") return;
      revisionRef.current += 1;
      const draft: GrammarPracticeDraft = {
        ...snapshot,
        revision: revisionRef.current
      };
      const targetSessionId = session.sessionId;
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(() => saveGrammarPracticeSessionDraft(targetSessionId, draft))
        .catch((saveError) => {
          console.warn("Grammar practice draft save failed", saveError);
        });
    },
    [session]
  );

  const initialElapsedSeconds = useMemo(() => {
    if (!session) return 0;
    if (positiveTimer) {
      return Math.max(
        session.elapsedSeconds || 0,
        Number(session.draft?.elapsedSeconds) || 0
      );
    }
    const startedAt = Date.parse(session.startedAt);
    const wallClockElapsed = Number.isFinite(startedAt)
      ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      : 0;
    return Math.max(session.elapsedSeconds || 0, wallClockElapsed);
  }, [positiveTimer, session]);

  if (loading) return <StudentLoadingState text="正在准备语法练习..." />;
  if (error) return <StudentErrorState text={error || "加载语法练习失败，请稍后重试。"} />;
  if ((!tag && !assignmentId) || !session) {
    return (
      <div className="grid gap-5">
        <GrammarNavigation tag={tag || undefined} />
        <StudentEmptyState text="该语法标签暂无可练习题目，无法开始练习。" />
      </div>
    );
  }
  if (session.status === "completed") {
    return (
      <StudentInfoStrip>这次语法练习已经完成，正在打开练习结果。</StudentInfoStrip>
    );
  }

  return (
    <PracticeSession
      key={`${session.sessionId}:${session.draft?.revision ?? 0}`}
      grammarSessionId={session.sessionId}
      hideQuestionCardNumber
      initialDraft={session.draft}
      initialElapsedSeconds={initialElapsedSeconds}
      initialQuestions={session.questions}
      onProgress={handleProgress}
      returnTo={returnTo}
      setId={`grammar-random-${session.sessionId}`}
      setTitle={positiveTimer ? session.category : `Grammar Practice · ${tag}`}
      stopwatch={positiveTimer}
      timed={!positiveTimer}
      totalSeconds={GRAMMAR_RANDOM_TIME_SECONDS}
    />
  );
}

function GrammarNavigation({ tag }: { tag?: string }) {
  return (
    <StudentNavigation
      backHref={tag ? STUDENT_ROUTES.grammarPractice : STUDENT_ROUTES.home}
      crumbs={[
        { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
        ...(tag
          ? [{ label: STUDENT_UI_TEXT.grammarPractice, href: STUDENT_ROUTES.grammarPractice }]
          : [{ label: STUDENT_UI_TEXT.grammarPractice }]),
        ...(tag ? [{ label: tag }] : [])
      ]}
    />
  );
}

export function useGrammarTags() {
  return useStudentCachedData<GrammarTagsPayload>(
    `${STUDENT_GRAMMAR_PRACTICE_CACHE_PREFIX}:tags`,
    (session) => loadGrammarPractice("", session)
  );
}

async function loadGrammarPractice(query: string, session: StudentCacheSession) {
  const response = await fetch(`/api/grammar-practice${query ? `?${query}` : ""}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const responseText = await response.text();
  let payload: GrammarTagsPayload | GrammarQuestionsPayload;

  try {
    payload = responseText
      ? JSON.parse(responseText)
      : { error: "语法练习服务返回了空响应。" };
  } catch {
    payload = { error: "语法练习服务返回的数据格式无效。" };
  }

  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? "无法加载语法练习。");
  }
  return payload;
}

function formatTimestamp(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}
