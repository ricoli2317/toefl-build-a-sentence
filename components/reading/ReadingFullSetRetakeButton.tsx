"use client";

import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  STUDENT_PRACTICE_HISTORY_CACHE_PREFIX,
  STUDENT_READING_FULL_SET_CACHE_PREFIX,
  useStudentDataCache
} from "@/components/StudentDataCache";
import { isReadingFullSetBootstrapPayload } from "@/lib/reading/fullSetAttempts";
import { storeReadingFullSetBootstrapHandoff } from "@/lib/reading/fullSetBootstrapHandoff.client";
import {
  createReadingFullSetPerformanceTrace,
  fetchReadingFullSetWithTimeout,
  logReadingFullSetPerformancePhase,
  readingFullSetTraceHeaders
} from "@/lib/reading/fullSetPerformance.client";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export function ReadingFullSetRetakeButton({
  compact = false,
  fullSetId,
  label
}: {
  compact?: boolean;
  fullSetId: string;
  label?: string;
}) {
  const router = useRouter();
  const cache = useStudentDataCache();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function retake() {
    if (loading) return;
    setLoading(true);
    setError("");
    const trace = createReadingFullSetPerformanceTrace(`pending-${fullSetId}`);
    logReadingFullSetPerformancePhase(trace, "m1_start_click", { moduleNumber: 1 });
    try {
      const session = cache.getSession();
      if (!session) throw new Error("请先登录后再重新练习。");
      const startedAt = performance.now();
      logReadingFullSetPerformancePhase(trace, "m1_start_request_start", {
        moduleNumber: 1,
        route: "/api/reading/full-set-attempts"
      });
      const response = await fetchReadingFullSetWithTimeout("/api/reading/full-set-attempts", {
        method: "POST",
        cache: "no-store",
        headers: {
          ...readingFullSetTraceHeaders(session.accessToken, trace),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ fullSetId })
      }, 20_000);
      const payload = await response.json().catch(() => ({})) as unknown;
      logReadingFullSetPerformancePhase(trace, "m1_bootstrap_response", {
        durationMs: performance.now() - startedAt,
        failure: response.ok ? null : "M1_PREPARE_FAILED",
        moduleNumber: 1,
        route: "/api/reading/full-set-attempts",
        success: response.ok
      });
      if (!response.ok || !isReadingFullSetBootstrapPayload(payload)) {
        const message = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
          ? (payload as { error: string }).error
          : "暂时无法开始再次练习。";
        throw new Error(message);
      }
      trace.attemptId = payload.runner.attempt.attemptId;
      storeReadingFullSetBootstrapHandoff(payload, trace);
      cache.invalidate(STUDENT_READING_FULL_SET_CACHE_PREFIX);
      cache.invalidate(STUDENT_PRACTICE_HISTORY_CACHE_PREFIX);
      cache.setData(`reading:full-sets:attempt:${fullSetId}`, { attempt: payload.runner.attempt });
      logReadingFullSetPerformancePhase(trace, "m1_route_navigation", {
        moduleNumber: 1,
        route: `${STUDENT_ROUTES.readingFullSets}/${fullSetId}/attempt/${payload.runner.attempt.attemptId}`
      });
      router.push(`${STUDENT_ROUTES.readingFullSets}/${encodeURIComponent(fullSetId)}/attempt/${encodeURIComponent(payload.runner.attempt.attemptId)}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "暂时无法开始再次练习。");
      setLoading(false);
    }
  }
  return (
    <div>
      <button
        className={compact ? "student-button-primary min-h-8 px-3 py-1 text-xs sm:text-[13px]" : "student-button-primary"}
        disabled={loading}
        onClick={retake}
        type="button"
      >
        <RotateCcw aria-hidden="true" size={17} />
        {loading ? "正在准备..." : label ?? "再次练习"}
      </button>
      {error ? <p className="mt-2 text-xs font-semibold text-student-error">{error}</p> : null}
    </div>
  );
}
