import type { SupabaseClient } from "@supabase/supabase-js";

export const SUPABASE_DEBUG_HEADER = "x-tps-db-metrics";
export const SUPABASE_DEBUG_REQUEST_HEADER = "x-tps-performance-debug";

export type SupabaseQueryMetric = {
  durationMs: number;
  error: boolean;
  operation: string;
  rows: number;
};

type QueryResult = {
  count?: number | null;
  data?: unknown;
  error?: unknown;
};

export function wantsSupabaseDebugMetrics(request: Request) {
  return process.env.NODE_ENV !== "production"
    && request.headers.get(SUPABASE_DEBUG_REQUEST_HEADER) === "1";
}

export function instrumentSupabaseClient<T extends SupabaseClient>(
  client: T,
  metrics: SupabaseQueryMetric[]
): T {
  return new Proxy(client, {
    get(target, property) {
      if (property === "from") {
        return (table: string) => wrapQuery(target.from(table), `from:${table}`, metrics);
      }
      if (property === "rpc") {
        return (fn: string, args?: Record<string, unknown>, options?: Record<string, unknown>) =>
          wrapQuery(target.rpc(fn, args, options), `rpc:${fn}`, metrics);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as T;
}

export function appendSupabaseDebugMetrics(
  response: Response,
  metrics: SupabaseQueryMetric[]
) {
  response.headers.set(
    SUPABASE_DEBUG_HEADER,
    Buffer.from(JSON.stringify(metrics)).toString("base64url")
  );
  return response;
}

function wrapQuery<T extends object>(
  query: T,
  operation: string,
  metrics: SupabaseQueryMetric[]
): T {
  return new Proxy(query, {
    get(target, property) {
      if (property === "then") {
        return (
          onFulfilled?: (value: QueryResult) => unknown,
          onRejected?: (reason: unknown) => unknown
        ) => {
          const startedAt = performance.now();
          return Promise.resolve(target as unknown as PromiseLike<QueryResult>)
            .then((result) => {
              const transferredRows = Array.isArray(result.data)
                ? result.data.length
                : result.data == null
                  ? 0
                  : 1;
              metrics.push({
                durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
                error: Boolean(result.error),
                operation,
                rows: transferredRows
              });
              return result;
            })
            .then(onFulfilled, onRejected);
        };
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args) as unknown;
        return result && typeof result === "object"
          ? wrapQuery(result, operation, metrics)
          : result;
      };
    }
  });
}
