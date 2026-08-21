type StudentPerformanceLayer = "auth" | "database" | "processing";

export type StudentPerformanceMetric = {
  durationMs: number;
  layer: StudentPerformanceLayer;
  name: string;
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
  finishHeaders: (headers?: HeadersInit) => Headers;
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

export function createStudentPerformanceTrace(route: string): StudentPerformanceTrace {
  const startedAt = performance.now();
  const startedAtIso = new Date().toISOString();
  const requestId = crypto.randomUUID();
  const metrics: StudentPerformanceMetric[] = [];
  let finished = false;

  function record(layer: StudentPerformanceLayer, name: string, start: number) {
    metrics.push({
      durationMs: roundDuration(performance.now() - start),
      layer,
      name
    });
  }

  return {
    async measure<T>(layer: StudentPerformanceLayer, name: string, operation: () => PromiseLike<T>) {
      const start = performance.now();
      try {
        return await operation();
      } finally {
        record(layer, name, start);
      }
    },
    measureSync<T>(
      layer: Extract<StudentPerformanceLayer, "processing">,
      name: string,
      operation: () => T
    ) {
      const start = performance.now();
      try {
        return operation();
      } finally {
        record(layer, name, start);
      }
    },
    finishHeaders(initialHeaders?: HeadersInit) {
      const headers = new Headers(initialHeaders);
      if (finished) return headers;
      finished = true;

      const totalMs = roundDuration(performance.now() - startedAt);
      const timingValues = [
        `api_total;dur=${totalMs};desc="API total"`,
        ...metrics.map((metric, index) =>
          `${serverTimingToken(metric.layer)}_${index + 1};dur=${metric.durationMs};desc="${serverTimingDescription(metric.name)}"`
        )
      ];
      headers.set("Server-Timing", timingValues.join(", "));
      headers.set("X-Student-Perf-Request-Id", requestId);

      console.info(
        "[student-perf]",
        JSON.stringify({
          event: "api_complete",
          metrics,
          requestId,
          route,
          scope: "server",
          startedAt: startedAtIso,
          totalMs
        })
      );
      return headers;
    }
  };
}
