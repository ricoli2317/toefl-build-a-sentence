type StudentPerformanceLayer = "auth" | "cache" | "database" | "processing";

export type StudentPerformanceMetric = {
  durationMs: number;
  failure: string | null;
  layer: StudentPerformanceLayer;
  name: string;
  success: boolean;
};

export type StudentPerformanceTraceContext = {
  attemptId?: string | null;
  moduleNumber?: number | null;
  traceId?: string | null;
};

export type StudentPerformanceTrace = {
  measure: <T>(
    layer: StudentPerformanceLayer,
    name: string,
    operation: () => PromiseLike<T>
  ) => Promise<T>;
  measureSync: <T>(
    layer: Extract<StudentPerformanceLayer, "processing">,
    name: string,
    operation: () => T
  ) => T;
  finishHeaders: (headers?: HeadersInit, success?: boolean) => Headers;
  traceId: string;
};

function roundDuration(value: number) {
  return Math.round(value * 10) / 10;
}

function serverTimingToken(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function serverTimingDescription(value: string) {
  return value.replace(/["\\]/g, "_");
}

export function createStudentPerformanceTrace(
  route: string,
  context: StudentPerformanceTraceContext = {}
): StudentPerformanceTrace {
  const startedAt = performance.now();
  const startedAtIso = new Date().toISOString();
  const requestId = crypto.randomUUID();
  const traceId = validTraceId(context.traceId) ? context.traceId : requestId;
  const metrics: StudentPerformanceMetric[] = [];
  let finished = false;

  function record(
    layer: StudentPerformanceLayer,
    name: string,
    start: number,
    success: boolean,
    error?: unknown
  ) {
    metrics.push({
      durationMs: roundDuration(performance.now() - start),
      failure: success ? null : performanceFailure(error),
      layer,
      name,
      success
    });
  }

  return {
    async measure<T>(layer: StudentPerformanceLayer, name: string, operation: () => PromiseLike<T>) {
      const start = performance.now();
      try {
        const result = await operation();
        record(layer, name, start, true);
        return result;
      } catch (error) {
        record(layer, name, start, false, error);
        throw error;
      }
    },
    measureSync<T>(
      layer: Extract<StudentPerformanceLayer, "processing">,
      name: string,
      operation: () => T
    ) {
      const start = performance.now();
      try {
        const result = operation();
        record(layer, name, start, true);
        return result;
      } catch (error) {
        record(layer, name, start, false, error);
        throw error;
      }
    },
    finishHeaders(initialHeaders?: HeadersInit, success = true) {
      const headers = new Headers(initialHeaders);
      if (finished) return headers;
      finished = true;
      headers.set("Cache-Control", "no-store");

      const totalMs = roundDuration(performance.now() - startedAt);
      const timingValues = [
        `api_total;dur=${totalMs};desc="API total"`,
        ...metrics.map((metric, index) =>
          `${serverTimingToken(metric.layer)}_${index + 1};dur=${metric.durationMs};desc="${serverTimingDescription(metric.name)}"`
        )
      ];
      headers.set("Server-Timing", timingValues.join(", "));
      headers.set("X-Student-Perf-Request-Id", requestId);
      headers.set("X-Student-Perf-Trace-Id", traceId);

      console.info(
        "[student-perf]",
        JSON.stringify({
          attemptId: context.attemptId ?? null,
          event: "api_complete",
          metrics: metrics.map((metric) => ({ ...metric, phase: metric.name })),
          moduleNumber: context.moduleNumber ?? null,
          requestId,
          route,
          scope: "server",
          serverTimestamp: new Date().toISOString(),
          startedAt: startedAtIso,
          success,
          traceId,
          totalMs
        })
      );
      return headers;
    },
    traceId
  };
}

function validTraceId(value: string | null | undefined): value is string {
  return typeof value === "string"
    && value.length <= 128
    && /^[a-zA-Z0-9_-]+$/.test(value);
}

function performanceFailure(error: unknown) {
  if (error instanceof Error) return error.name;
  return typeof error === "string" ? "Error" : "UnknownError";
}
