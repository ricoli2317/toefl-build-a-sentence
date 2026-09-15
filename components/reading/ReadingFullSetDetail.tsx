"use client";

import Link from "next/link";
import { BookOpen, Clock3, Eye, Info } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  useStudentCachedData,
  useStudentDataCache,
  STUDENT_READING_FULL_SET_CACHE_PREFIX,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import {
  StudentErrorState,
  StudentNavigation
} from "@/components/student/StudentUI";
import type { ReadingFullSet } from "@/lib/reading/fullSets";
import {
  isReadingFullSetBootstrapPayload,
  isReadingFullSetAttemptSummary,
  readingFullSetPrepAction,
  type ReadingFullSetBootstrapPayload,
  type ReadingFullSetAttemptSummary
} from "@/lib/reading/fullSetAttempts";
import { storeReadingFullSetBootstrapHandoff } from "@/lib/reading/fullSetBootstrapHandoff.client";
import {
  createReadingFullSetPerformanceTrace,
  fetchReadingFullSetWithTimeout,
  logReadingFullSetPerformancePhase,
  readingFullSetServerTimingDuration,
  readingFullSetTraceHeaders,
  type ReadingFullSetPerformanceTrace
} from "@/lib/reading/fullSetPerformance.client";
import { formatReadingFullSetTime } from "@/lib/reading/fullSetPresentation";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { ReadingFullSetRetakeButton } from "./ReadingFullSetRetakeButton";

type ReadingFullSetDetailPayload = {
  fullSet: ReadingFullSet;
};

type ReadingFullSetAttemptPayload = {
  attempt: ReadingFullSetAttemptSummary | null;
};

export function ReadingFullSetDetail({ fullSetId }: { fullSetId: string }) {
  const router = useRouter();
  const cache = useStudentDataCache();
  const cacheKey = `reading:full-sets:detail:${fullSetId}`;
  const attemptCacheKey = `reading:full-sets:attempt:${fullSetId}`;
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState("");
  const detailState = useStudentCachedData<ReadingFullSetDetailPayload>(
    cacheKey,
    (session) => loadReadingFullSetDetail(fullSetId, session)
  );
  const attemptState = useStudentCachedData<ReadingFullSetAttemptPayload>(
    attemptCacheKey,
    (session) => loadReadingFullSetAttempt(fullSetId, session),
    { refreshOnMount: true }
  );
  const title = detailState.data?.fullSet.title ?? fullSetId;
  const action = readingFullSetPrepAction(attemptState.data?.attempt ?? null);

  const enterPractice = async () => {
    if (starting || action.action === "completed") return;
    setStarting(true);
    setActionError("");
    const trace = createReadingFullSetPerformanceTrace(
      attemptState.data?.attempt?.attemptId ?? `pending-${fullSetId}`
    );
    const isM1Entry = action.action === "start_module_1" || action.action === "continue_module_1";
    if (isM1Entry) {
      logReadingFullSetPerformancePhase(trace, "m1_start_click", { moduleNumber: 1 });
    }
    try {
      const session = cache.getSession();
      if (!session) throw new Error("请先登录后再开始套题练习。");
      let attempt = attemptState.data?.attempt ?? null;
      if (isM1Entry) {
        const bootstrap = await startReadingFullSetAttempt(fullSetId, session.accessToken, trace);
        attempt = bootstrap.runner.attempt;
        trace.attemptId = attempt.attemptId;
        storeReadingFullSetBootstrapHandoff(bootstrap, trace);
      } else if (action.action === "start_module_2" && attempt) {
        attempt = await startReadingFullSetModule2(attempt.attemptId, session.accessToken);
      }
      if (!attempt) throw new Error("套题练习状态暂时不可用。");
      cache.setData<ReadingFullSetAttemptPayload>(attemptCacheKey, { attempt });
      cache.invalidate(`${STUDENT_READING_FULL_SET_CACHE_PREFIX}:catalog`);
      if (isM1Entry) {
        logReadingFullSetPerformancePhase(trace, "m1_route_navigation", {
          moduleNumber: 1,
          route: `${STUDENT_ROUTES.readingFullSets}/${fullSetId}/attempt/${attempt.attemptId}`
        });
      }
      router.push(
        `${STUDENT_ROUTES.readingFullSets}/${encodeURIComponent(fullSetId)}/attempt/${encodeURIComponent(attempt.attemptId)}`
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "暂时无法进入套题练习。");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="grid gap-5">
      <StudentNavigation
        backHref={STUDENT_ROUTES.readingFullSets}
        crumbs={[
          { label: "学生首页", href: STUDENT_ROUTES.home },
          { label: "Full Set Practice", href: STUDENT_ROUTES.readingFullSets },
          { label: title }
        ]}
      />
      {detailState.loading ? <ReadingFullSetDetailSkeleton /> : null}
      {!detailState.loading && (detailState.error || !detailState.data?.fullSet) ? (
        <div className="grid gap-4">
          <StudentErrorState text="套题加载失败，请重试。" />
          <button
            className="student-button-secondary justify-self-start"
            onClick={() => cache.invalidate(cacheKey)}
            type="button"
          >
            重新加载
          </button>
        </div>
      ) : null}
      {!detailState.loading && detailState.data?.fullSet ? (
        <FullSetPreparation
          actionError={attemptState.error || actionError}
          actionLabel={starting ? "正在进入..." : action.label}
          actionLoading={attemptState.loading || starting}
          actionUnavailable={action.action === "completed"}
          completedAttemptId={action.action === "completed" ? attemptState.data?.attempt?.attemptId ?? null : null}
          fullSet={detailState.data.fullSet}
          onAction={() => void enterPractice()}
        />
      ) : null}
    </div>
  );
}

function FullSetPreparation({
  actionError,
  actionLabel,
  actionLoading,
  actionUnavailable,
  fullSet,
  completedAttemptId,
  onAction
}: {
  actionError: string;
  actionLabel: string;
  actionLoading: boolean;
  actionUnavailable: boolean;
  fullSet: ReadingFullSet;
  completedAttemptId: string | null;
  onAction: () => void;
}) {
  return (
    <section className="student-card overflow-hidden p-0">
      <div className="border-b border-student-border p-5 sm:p-6">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-[#347fdc]">
            <BookOpen aria-hidden="true" size={22} strokeWidth={1.9} />
          </span>
          <div>
            <p className="text-xs font-semibold text-student-muted">完整阅读套题</p>
            <h2 className="mt-0.5 break-all text-2xl font-bold text-student-text" data-full-set-title>
              {fullSet.title}
            </h2>
          </div>
        </div>
      </div>

      <div className="grid gap-3 p-5 sm:grid-cols-2 sm:p-6">
        <DetailModule
          label="Module 1"
          questionCount={35}
          timeLimitSeconds={fullSet.module1.timeLimitSeconds!}
        />
        <DetailModule
          label="Module 2"
          questionCount={15}
          timeLimitSeconds={fullSet.module2.timeLimitSeconds}
        />
      </div>

      <div className="border-t border-student-border bg-student-bg p-5 sm:p-6">
        <div className="flex items-center gap-2 text-student-text">
          <Info aria-hidden="true" className="text-student-primary" size={19} />
          <h3 className="font-bold">练习规则</h3>
        </div>
        <ul className="mt-3 grid gap-2 pl-5 text-sm leading-6 text-student-muted">
          <li className="list-disc">两个 Module 分别计时</li>
          <li className="list-disc">Module 1 提交后进入 Module 2</li>
          <li className="list-disc">每个 Module 开始后独立倒计时</li>
        </ul>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
          {actionError ? <p className="mr-auto text-sm font-semibold text-student-error">{actionError}</p> : null}
          {actionUnavailable && completedAttemptId ? (
            <>
              <Link
                className="student-button-secondary"
                href={`${STUDENT_ROUTES.readingFullSets}/${encodeURIComponent(fullSet.fullSetId!)}/result/${encodeURIComponent(completedAttemptId)}`}
              >
                <Eye aria-hidden="true" size={17} />查看结果
              </Link>
              <ReadingFullSetRetakeButton fullSetId={fullSet.fullSetId!} />
            </>
          ) : (
            <button
              className="student-button-primary min-h-10 px-4"
              disabled={actionLoading}
              onClick={onAction}
              type="button"
            >
              {actionLabel}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function DetailModule({
  label,
  questionCount,
  timeLimitSeconds
}: {
  label: string;
  questionCount: number;
  timeLimitSeconds: number;
}) {
  return (
    <div className="rounded-2xl border border-student-border p-4">
      <p className="text-base font-bold text-student-text">{label}</p>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-student-muted">
        <span>{questionCount}题</span>
        <span className="inline-flex items-center gap-1.5">
          <Clock3 aria-hidden="true" size={16} strokeWidth={1.9} />
          {formatReadingFullSetTime(timeLimitSeconds)}
        </span>
      </div>
    </div>
  );
}

function ReadingFullSetDetailSkeleton() {
  return (
    <div aria-label="正在加载套题详情" className="student-card min-h-[390px] animate-pulse p-6" role="status">
      <div className="flex items-center gap-3">
        <span className="h-11 w-11 rounded-xl bg-slate-100" />
        <span className="h-7 w-40 rounded bg-slate-100" />
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <span className="h-24 rounded-2xl bg-slate-100" />
        <span className="h-24 rounded-2xl bg-slate-100" />
      </div>
      <span className="mt-7 block h-28 rounded-2xl bg-slate-100" />
      <span className="sr-only">正在加载套题详情...</span>
    </div>
  );
}

async function loadReadingFullSetDetail(fullSetId: string, session: StudentCacheSession) {
  const response = await fetch(`/api/reading/full-sets/${encodeURIComponent(fullSetId)}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  const payload = await response.json().catch(() => ({})) as ReadingFullSetDetailPayload & {
    error?: string;
  };
  if (!response.ok || payload.error || !payload.fullSet) {
    throw new Error(payload.error ?? "套题加载失败，请重试。");
  }
  return payload;
}

async function loadReadingFullSetAttempt(fullSetId: string, session: StudentCacheSession) {
  const response = await fetch(
    `/api/reading/full-set-attempts?fullSetId=${encodeURIComponent(fullSetId)}`,
    { cache: "no-store", headers: { Authorization: `Bearer ${session.accessToken}` } }
  );
  const payload = await response.json().catch(() => ({})) as ReadingFullSetAttemptPayload & { error?: string };
  if (!response.ok || payload.error || (payload.attempt !== null && !isReadingFullSetAttemptSummary(payload.attempt))) {
    throw new Error(payload.error ?? "套题练习状态加载失败，请重试。");
  }
  return payload;
}

async function startReadingFullSetAttempt(
  fullSetId: string,
  accessToken: string,
  trace: ReadingFullSetPerformanceTrace
): Promise<ReadingFullSetBootstrapPayload> {
  const route = "/api/reading/full-set-attempts";
  const startedAt = performance.now();
  logReadingFullSetPerformancePhase(trace, "m1_start_request_start", { moduleNumber: 1, route });
  try {
    const response = await fetchReadingFullSetWithTimeout(route, {
      method: "POST",
      cache: "no-store",
      headers: {
        ...readingFullSetTraceHeaders(accessToken, trace),
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fullSetId })
    }, 20_000);
    const payload = await response.json().catch(() => ({})) as unknown;
    for (const [phase, serverPhase] of [
      ["m1_attempt_prepare", "attempt_create_or_reuse"],
      ["m1_definition_resolution", "definition_resolution"],
      ["m1_first_occurrence_content", "first_occurrence_content"]
    ] as const) {
      const durationMs = readingFullSetServerTimingDuration(response, serverPhase);
      if (durationMs !== null) {
        logReadingFullSetPerformancePhase(trace, phase, { durationMs, moduleNumber: 1, route });
      }
    }
    logReadingFullSetPerformancePhase(trace, "m1_bootstrap_response", {
      durationMs: performance.now() - startedAt,
      failure: response.ok ? null : bootstrapErrorCode(payload),
      moduleNumber: 1,
      route,
      success: response.ok
    });
    if (!response.ok || !isReadingFullSetBootstrapPayload(payload)) {
      throw new Error(bootstrapErrorMessage(payload) ?? "暂时无法开始 Module 1。");
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === "ReadingFullSetRequestTimeout") {
      logReadingFullSetPerformancePhase(trace, "m1_bootstrap_response", {
        durationMs: performance.now() - startedAt,
        failure: "BOOTSTRAP_TIMEOUT",
        moduleNumber: 1,
        route,
        success: false
      });
      throw new Error("Module 1 准备超时，请重试。");
    }
    throw error;
  }
}

async function startReadingFullSetModule2(attemptId: string, accessToken: string) {
  const response = await fetch(
    `/api/reading/full-set-attempts/${encodeURIComponent(attemptId)}/modules/2/start`,
    { method: "POST", cache: "no-store", headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return readingFullSetAttemptResponse(response, "暂时无法开始 Module 2。");
}

async function readingFullSetAttemptResponse(response: Response, fallback: string) {
  const payload = await response.json().catch(() => ({})) as {
    attempt?: ReadingFullSetAttemptSummary;
    error?: string;
  };
  if (!response.ok || !isReadingFullSetAttemptSummary(payload.attempt)) {
    throw new Error(payload.error ?? fallback);
  }
  return payload.attempt;
}

function bootstrapErrorCode(payload: unknown) {
  return payload && typeof payload === "object" && typeof (payload as { code?: unknown }).code === "string"
    ? (payload as { code: string }).code
    : "M1_PREPARE_FAILED";
}

function bootstrapErrorMessage(payload: unknown) {
  return payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
    ? (payload as { error: string }).error
    : null;
}
