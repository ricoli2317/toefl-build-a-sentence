"use client";

import { useEffect, useRef } from "react";

type PageTrace = {
  actualRoute: string;
  completed: boolean;
  contentVisibleLogged: boolean;
  expectedRoute: string;
  firstRequestStartedMs: number | null;
  mainDataCompleted: boolean;
  requestCount: number;
  startLogged: boolean;
  startedAt: number;
  startedAtEpochMs: number;
  traceId: string;
};

type ServerTimingMetric = {
  durationMs: number;
  name: string;
  description: string;
};

let activePageTrace: PageTrace | null = null;

function roundDuration(value: number) {
  return Math.round(value * 10) / 10;
}

function currentRoute(fallback: string) {
  return typeof window === "undefined"
    ? fallback
    : `${window.location.pathname}${window.location.search}`;
}

function createPageTrace(expectedRoute: string): PageTrace {
  const now = performance.now();
  return {
    actualRoute: expectedRoute,
    completed: false,
    contentVisibleLogged: false,
    expectedRoute,
    firstRequestStartedMs: null,
    mainDataCompleted: false,
    requestCount: 0,
    startLogged: false,
    startedAt: now,
    startedAtEpochMs: Date.now(),
    traceId: crypto.randomUUID()
  };
}

function getPageTrace(expectedRoute: string) {
  if (
    !activePageTrace ||
    activePageTrace.expectedRoute !== expectedRoute ||
    (activePageTrace.completed && performance.now() - activePageTrace.startedAt > 500)
  ) {
    activePageTrace = createPageTrace(expectedRoute);
  }
  return activePageTrace;
}

export function logStudentPerformance(payload: Record<string, unknown>) {
  console.info("[student-perf]", JSON.stringify({ scope: "client", ...payload }));
}

export function beginStudentNavigationTrace(expectedRoute: string) {
  if (typeof window === "undefined") return;
  const trace = createPageTrace(expectedRoute);
  activePageTrace = trace;
  logStudentPerformance({
    event: "navigation_started",
    expectedRoute,
    fromRoute: currentRoute(""),
    startedAt: new Date(trace.startedAtEpochMs).toISOString(),
    traceId: trace.traceId
  });
}

export function useStudentPagePerformance({
  errors = [],
  loading,
  route
}: {
  errors?: Array<string | null | undefined>;
  loading: boolean;
  route: string;
}) {
  const traceRef = useRef<PageTrace | null>(null);
  if (!traceRef.current) traceRef.current = getPageTrace(route);

  useEffect(() => {
    const trace = traceRef.current!;
    if (trace.startLogged) return;
    trace.actualRoute = currentRoute(route);
    trace.startLogged = true;
    logStudentPerformance({
      actualRoute: trace.actualRoute,
      event: "page_load_started",
      expectedRoute: trace.expectedRoute,
      startedAt: new Date(trace.startedAtEpochMs).toISOString(),
      traceId: trace.traceId
    });
  }, [route]);

  useEffect(() => {
    const trace = traceRef.current!;
    if (loading || trace.mainDataCompleted) return;
    trace.mainDataCompleted = true;
    const outcome = errors.some(Boolean) ? "error" : "success";
    logStudentPerformance({
      actualRoute: trace.actualRoute,
      completedAt: new Date().toISOString(),
      event: "page_main_data_complete",
      expectedRoute: trace.expectedRoute,
      frontendWaitBeforeFirstRequestMs:
        trace.firstRequestStartedMs === null
          ? null
          : roundDuration(trace.firstRequestStartedMs - trace.startedAt),
      outcome,
      requestCount: trace.requestCount,
      totalMs: roundDuration(performance.now() - trace.startedAt),
      traceId: trace.traceId
    });
    requestAnimationFrame(() => {
      if (trace.contentVisibleLogged) return;
      trace.contentVisibleLogged = true;
      trace.completed = true;
      logStudentPerformance({
        actualRoute: trace.actualRoute,
        event: "page_main_content_visible",
        expectedRoute: trace.expectedRoute,
        outcome,
        requestCount: trace.requestCount,
        totalMs: roundDuration(performance.now() - trace.startedAt),
        traceId: trace.traceId,
        visibleAt: new Date().toISOString()
      });
    });
  }, [errors, loading]);
}

export async function measureStudentRequest<T>(
  requestName: string,
  operation: (captureResponse: (response: Response) => void) => Promise<T>
): Promise<T> {
  const trace = activePageTrace && !activePageTrace.completed ? activePageTrace : null;
  const startedAt = performance.now();
  const responseHolder: { current: Response | null } = { current: null };
  if (trace) {
    trace.requestCount += 1;
    trace.firstRequestStartedMs ??= startedAt;
  }

  try {
    return await operation((value) => {
      responseHolder.current = value;
    });
  } finally {
    const response = responseHolder.current;
    const totalMs = roundDuration(performance.now() - startedAt);
    const serverTimings = parseServerTiming(response?.headers.get("Server-Timing") ?? null);
    const apiTotalMs = serverTimings.find((metric) => metric.name === "api_total")?.durationMs;
    logStudentPerformance({
      apiTotalMs: apiTotalMs ?? null,
      event: "request_complete",
      frontendAndNetworkWaitMs:
        apiTotalMs === undefined ? null : roundDuration(Math.max(0, totalMs - apiTotalMs)),
      pageElapsedAtRequestStartMs: trace
        ? roundDuration(startedAt - trace.startedAt)
        : null,
      pageTraceId: trace?.traceId ?? null,
      requestId: response?.headers.get("X-Student-Perf-Request-Id") ?? null,
      requestName,
      serverTimings,
      status: response?.status ?? null,
      totalMs
    });
  }
}

function parseServerTiming(value: string | null): ServerTimingMetric[] {
  if (!value) return [];
  return value.split(",").flatMap((entry) => {
    const [name, ...parameters] = entry.trim().split(";");
    const duration = parameters.find((parameter) => parameter.trim().startsWith("dur="));
    const description = parameters.find((parameter) => parameter.trim().startsWith("desc="));
    const durationMs = Number(duration?.trim().slice("dur=".length));
    if (!name || !Number.isFinite(durationMs)) return [];
    return [{
      description: description?.trim().slice("desc=".length).replace(/^"|"$/g, "") ?? "",
      durationMs,
      name
    }];
  });
}
