"use client";

import { logStudentPerformance } from "@/lib/studentPerformance.client";

export type ReadingFullSetPerformancePhase =
  | "m1_submit_click"
  | "m1_final_flush_start"
  | "m1_final_flush_end"
  | "m1_submit_request_start"
  | "m1_submit_request_end"
  | "m2_start_click"
  | "m2_bootstrap_request_start"
  | "m2_bootstrap_response"
  | "m2_state_applied"
  | "m2_first_ctw_mounted"
  | "m2_first_interactive"
  | "m2_activation_start"
  | "m2_activation_end"
  | "m2_countdown_active"
  | "next_prefetch_start"
  | "next_prefetch_content_end"
  | "rdl_image_preload_start"
  | "rdl_image_preload_end"
  | "next_prefetch_ready"
  | "navigation_click"
  | "answer_snapshot_created"
  | "background_save_enqueued"
  | "background_save_started"
  | "background_save_success"
  | "background_save_retry"
  | "background_save_error"
  | "navigation_after_enqueue"
  | "durability_flush_start"
  | "durability_flush_end"
  | "current_save_start"
  | "current_save_end"
  | "navigation_cache_hit"
  | "navigation_cache_wait"
  | "navigation_cache_miss"
  | "next_workspace_mounted"
  | "next_first_interactive";

export type ReadingFullSetPerformanceTrace = {
  attemptId: string;
  startedAt: number;
  traceId: string;
};

export function createReadingFullSetPerformanceTrace(attemptId: string) {
  return {
    attemptId,
    startedAt: performance.now(),
    traceId: crypto.randomUUID()
  } satisfies ReadingFullSetPerformanceTrace;
}

export function logReadingFullSetPerformancePhase(
  trace: ReadingFullSetPerformanceTrace,
  phase: ReadingFullSetPerformancePhase,
  input: {
    cacheStatus?: "hit" | "miss" | "wait";
    durationMs?: number;
    failure?: string | null;
    imagePreloadStatus?: "failed" | "hit" | "miss" | "not_applicable";
    moduleNumber: 1 | 2;
    occurrenceId?: string;
    route?: string | null;
    saveDurationMs?: number;
    success?: boolean;
    taskType?: "ctw" | "rap" | "rdl";
    totalDurationMs?: number;
  }
) {
  logStudentPerformance({
    attemptId: trace.attemptId,
    cacheStatus: input.cacheStatus ?? null,
    durationMs: roundDuration(input.durationMs ?? 0),
    elapsedMs: roundDuration(performance.now() - trace.startedAt),
    event: "reading_full_set_transition_phase",
    failure: input.failure ?? null,
    imagePreloadStatus: input.imagePreloadStatus ?? null,
    moduleNumber: input.moduleNumber,
    occurrenceId: input.occurrenceId ?? null,
    phase,
    route: input.route ?? null,
    saveDurationMs: roundDuration(input.saveDurationMs ?? 0),
    success: input.success ?? true,
    taskType: input.taskType ?? null,
    timestamp: new Date().toISOString(),
    totalDurationMs: roundDuration(input.totalDurationMs ?? 0),
    traceId: trace.traceId
  });
}

export function readingFullSetTraceHeaders(
  token: string,
  trace: ReadingFullSetPerformanceTrace | null
) {
  return {
    Authorization: `Bearer ${token}`,
    ...(trace ? { "X-Reading-Full-Set-Trace-Id": trace.traceId } : {})
  };
}

export async function fetchReadingFullSetWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error("Request timed out");
      timeoutError.name = "ReadingFullSetRequestTimeout";
      throw timeoutError;
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function roundDuration(value: number) {
  return Math.round(value * 10) / 10;
}
