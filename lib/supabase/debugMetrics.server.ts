import type { SupabaseClient } from "@supabase/supabase-js";
import { AsyncLocalStorage } from "node:async_hooks";

export const SUPABASE_DEBUG_HEADER = "x-tps-db-metrics";
export const SUPABASE_DEBUG_REQUEST_HEADER = "x-tps-performance-debug";
export const SERVER_DEBUG_HEADER = "x-tps-stage-metrics";

export type SupabaseQueryMetric = {
  dependsOn: string[];
  durationMs: number;
  error: boolean;
  operation: string;
  query: string;
  rows: number;
  selectedColumns: string;
  startedAtMs: number;
  table: string;
};

export type ServerDebugMetric = {
  dependsOn: string[];
  durationMs: number;
  rows: number | null;
  stage: string;
  startedAtMs: number;
};

export type ServerDebugTrace = {
  measure: <T>(
    stage: string,
    dependsOn: string[],
    operation: () => PromiseLike<T>,
    rows?: (value: T) => number | null
  ) => Promise<T>;
  measureSync: <T>(
    stage: string,
    dependsOn: string[],
    operation: () => T,
    rows?: (value: T) => number | null
  ) => T;
  record: (stage: string, durationMs: number, dependsOn?: string[], rows?: number | null) => void;
};

type SupabaseQueryContext = {
  dependsOn?: string[];
  query: string;
};

type QueryResult = {
  count?: number | null;
  data?: unknown;
  error?: unknown;
};

const queryContext = new AsyncLocalStorage<SupabaseQueryContext>();
const metricOrigins = new WeakMap<SupabaseQueryMetric[] | ServerDebugMetric[], number>();

function originFor(metrics: SupabaseQueryMetric[] | ServerDebugMetric[]) {
  const existing = metricOrigins.get(metrics);
  if (existing !== undefined) return existing;
  const origin = performance.now();
  metricOrigins.set(metrics, origin);
  return origin;
}

function rounded(value: number) {
  return Math.round(value * 10) / 10;
}

export function synchronizeServerDebugOrigins(
  ...collections: Array<SupabaseQueryMetric[] | ServerDebugMetric[]>
) {
  const origin = performance.now();
  for (const metrics of collections) metricOrigins.set(metrics, origin);
}

export function wantsSupabaseDebugMetrics(request: Request) {
  return process.env.NODE_ENV !== "production"
    && (
      process.env.TPS_PERFORMANCE_DEBUG_ALL === "1"
      || request.headers.get(SUPABASE_DEBUG_REQUEST_HEADER) === "1"
    );
}

export function instrumentSupabaseClient<T extends SupabaseClient>(
  client: T,
  metrics: SupabaseQueryMetric[]
): T {
  return new Proxy(client, {
    get(target, property) {
      if (property === "from") {
        return (table: string) => wrapQuery(target.from(table), table, metrics, { selectedColumns: "" });
      }
      if (property === "rpc") {
        return (fn: string, args?: Record<string, unknown>, options?: Record<string, unknown>) =>
          wrapQuery(target.rpc(fn, args, options), `rpc:${fn}`, metrics, { selectedColumns: "rpc" });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as T;
}

export function appendSupabaseDebugMetrics(
  response: Response,
  metrics: SupabaseQueryMetric[],
  stages: ServerDebugMetric[] = []
) {
  console.info("[tps-stage-profile]", JSON.stringify({ queries: metrics, stages }));
  response.headers.set(
    SUPABASE_DEBUG_HEADER,
    Buffer.from(JSON.stringify(metrics)).toString("base64url")
  );
  if (stages.length > 0) {
    response.headers.set(
      SERVER_DEBUG_HEADER,
      Buffer.from(JSON.stringify(stages)).toString("base64url")
    );
  }
  return response;
}

export function profileSupabaseQuery<T>(
  context: SupabaseQueryContext,
  operation: () => PromiseLike<T>
) {
  return queryContext.run(context, async () => await operation());
}

export function createServerDebugTrace(
  metrics: ServerDebugMetric[],
  enabled: boolean
): ServerDebugTrace {
  const origin = originFor(metrics);
  const push = (
    stage: string,
    startedAt: number,
    dependsOn: string[],
    rows: number | null
  ) => {
    if (!enabled) return;
    metrics.push({
      dependsOn,
      durationMs: rounded(performance.now() - startedAt),
      rows,
      stage,
      startedAtMs: rounded(startedAt - origin)
    });
  };
  return {
    async measure(stage, dependsOn, operation, rows) {
      const startedAt = performance.now();
      try {
        const value = await operation();
        push(stage, startedAt, dependsOn, rows?.(value) ?? null);
        return value;
      } catch (error) {
        push(stage, startedAt, dependsOn, null);
        throw error;
      }
    },
    measureSync(stage, dependsOn, operation, rows) {
      const startedAt = performance.now();
      try {
        const value = operation();
        push(stage, startedAt, dependsOn, rows?.(value) ?? null);
        return value;
      } catch (error) {
        push(stage, startedAt, dependsOn, null);
        throw error;
      }
    },
    record(stage, durationMs, dependsOn = [], rows = null) {
      if (!enabled) return;
      metrics.push({
        dependsOn,
        durationMs: rounded(durationMs),
        rows,
        stage,
        startedAtMs: rounded(performance.now() - origin - durationMs)
      });
    }
  };
}

function wrapQuery<T extends object>(
  query: T,
  table: string,
  metrics: SupabaseQueryMetric[],
  state: { selectedColumns: string }
): T {
  return new Proxy(query, {
    get(target, property) {
      if (property === "then") {
        return (
          onFulfilled?: (value: QueryResult) => unknown,
          onRejected?: (reason: unknown) => unknown
        ) => {
          const startedAt = performance.now();
          const context = queryContext.getStore();
          const operation = table.startsWith("rpc:") ? table : `from:${table}`;
          return Promise.resolve(target as unknown as PromiseLike<QueryResult>)
            .then((result) => {
              const transferredRows = Array.isArray(result.data)
                ? result.data.length
                : result.data == null
                  ? 0
                  : 1;
              metrics.push({
                dependsOn: context?.dependsOn ?? [],
                durationMs: rounded(performance.now() - startedAt),
                error: Boolean(result.error),
                operation,
                query: context?.query ?? operation,
                rows: transferredRows,
                selectedColumns: state.selectedColumns,
                startedAtMs: rounded(startedAt - originFor(metrics)),
                table
              });
              return result;
            })
            .then(onFulfilled, onRejected);
        };
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (property === "select" && typeof args[0] === "string") {
          state.selectedColumns = args[0];
        }
        const result = Reflect.apply(value, target, args) as unknown;
        return result && typeof result === "object"
          ? wrapQuery(result, table, metrics, state)
          : result;
      };
    }
  });
}
