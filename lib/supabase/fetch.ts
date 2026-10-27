const RETRYABLE_READ_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

type FetchLike = typeof fetch;

type SupabaseFetchOptions = {
  fetchImpl?: FetchLike;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  // Omitted on server clients. This is a build-time administrator switch,
  // never a per-request fallback after an authentication failure.
  authProxy?: { projectUrl: string; mode: string };
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
  if (options.authProxy && !["proxy", "direct"].includes(options.authProxy.mode)) {
    throw new Error("Invalid NEXT_PUBLIC_SUPABASE_AUTH_TRANSPORT (use proxy or direct).");
  }
  const authUrl = options.authProxy
    ? new URL("auth/v1/", `${options.authProxy.projectUrl.replace(/\/$/, "")}/`)
    : null;

  return async (input, init) => {
    const method = requestMethod(input, init);
    // SDK URLs are absolute. Leave unrelated relative fetch inputs untouched.
    let url: URL | null = null;
    if (authUrl) {
      try { url = new URL(input instanceof Request ? input.url : String(input)); } catch { /* not an Auth URL */ }
    }
    const isAuth = !!(url && authUrl && url.origin === authUrl.origin && url.pathname.startsWith(authUrl.pathname));
    if (isAuth && url && authUrl && options.authProxy?.mode === "proxy") {
      const target = `/api/supabase/auth/v1/${url.pathname.slice(authUrl.pathname.length)}${url.search}`;
      const started = performance.now();
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      let requestId: string | undefined;
      try { requestId = globalThis.crypto?.randomUUID?.(); } catch { /* diagnostics must not block Auth */ }
      if (requestId) headers.set("x-tps-auth-request-id", requestId);
      try {
        // Request inputs retain method/body/signal; the SDK currently uses URLs.
        const forwarded = input instanceof Request ? new Request(new URL(target, window.location.origin), input) : target;
        const response = await fetchImpl(forwarded, {
          ...init, headers, cache: "no-store", credentials: "omit", redirect: "error"
        });
        if (!response.ok) {
          const category = response.headers.get("x-tps-auth-result");
          console.warn("[auth-proxy-browser]", {
            code: proxyDiagnostic(category), status: response.status,
            durationMs: Math.round(performance.now() - started),
            requestId: safeRequestId(response.headers.get("x-tps-auth-request-id")) ?? requestId ?? null
          });
        }
        return response;
      } catch (error) {
        console.warn("[auth-proxy-browser]", {
          code: isAbortError(error) ? "TPS-AUTH-PROXY-ABORT" : "TPS-AUTH-PROXY-ENTRY",
          status: null, durationMs: Math.round(performance.now() - started), requestId: requestId ?? null
        });
        // Auth SDK logs thrown errors: do not let raw transport errors leak URLs.
        if (isAbortError(error)) throw new DOMException("Aborted", "AbortError");
        throw new TypeError("Failed to fetch");
      }
    }
    const retryableRead = !isAuth && (method === "GET" || method === "HEAD");
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

function safeRequestId(value: string | null) {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function proxyDiagnostic(category: string | null) {
  switch (category) {
    case "upstream_network": return "TPS-AUTH-PROXY-UPSTREAM-NET";
    case "timeout": return "TPS-AUTH-PROXY-TIMEOUT";
    case "upstream_4xx": return "TPS-AUTH-PROXY-4XX";
    case "upstream_429": return "TPS-AUTH-PROXY-429";
    case "upstream_5xx": return "TPS-AUTH-PROXY-5XX";
    default: return "TPS-AUTH-PROXY-HTTP";
  }
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
