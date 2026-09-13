const RETRYABLE_READ_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

type FetchLike = typeof fetch;

type SupabaseFetchOptions = {
  fetchImpl?: FetchLike;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

/**
 * Supabase/PostgREST reads must bypass the Next/Vercel fetch cache. A single
 * retry absorbs short network/upstream interruptions without ever replaying a
 * write, an auth/permission failure, or a schema/business error.
 */
export function createSupabaseFetch(options: SupabaseFetchOptions = {}): FetchLike {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? 75;
  const sleep = options.sleep ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  return async (input, init) => {
    const method = requestMethod(input, init);
    const retryableRead = method === "GET" || method === "HEAD";
    const requestInit = { ...init, cache: "no-store" as const };

    try {
      const response = await fetchImpl(input, requestInit);
      if (!retryableRead || !RETRYABLE_READ_STATUSES.has(response.status)) {
        return response;
      }
      await sleep(retryDelay(response, retryDelayMs));
      return fetchImpl(input, requestInit);
    } catch (error) {
      if (!retryableRead || isAbortError(error)) throw error;
      await sleep(retryDelayMs);
      return fetchImpl(input, requestInit);
    }
  };
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit) {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function retryDelay(response: Response, fallback: number) {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return fallback;
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds)
    ? Math.min(Math.max(seconds * 1000, 0), 500)
    : fallback;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}
