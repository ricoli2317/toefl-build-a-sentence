import { randomUUID } from "node:crypto";

const PREFIX = "/api/supabase/auth/v1/";
const BODY_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const TIMEOUT_MS = 15_000;
const ENDPOINTS: Record<string, { methods: string[]; queries: string[] }> = {
  token: { methods: ["POST"], queries: ["grant_type"] },
  logout: { methods: ["POST"], queries: ["scope"] },
  user: { methods: ["GET", "PUT"], queries: ["redirect_to"] },
  recover: { methods: ["POST"], queries: ["redirect_to"] },
  verify: { methods: ["POST"], queries: [] },
  reauthenticate: { methods: ["GET"], queries: [] },
  ".well-known/jwks.json": { methods: ["GET"], queries: [] }
};
const REQUEST_HEADERS = ["authorization", "apikey", "content-type", "accept", "x-client-info", "x-supabase-api-version", "origin"];
const RESPONSE_HEADERS = ["content-type", "retry-after", "www-authenticate", "x-supabase-api-version", "allow"];
type Diagnostic = {
  event: "auth_proxy"; requestId: string; phase: string; status: number;
  result: string; durationMs: number; upstreamMs: number | null;
};
type Dependencies = {
  projectUrl?: string; anonKey?: string; fetchImpl?: typeof fetch;
  timeoutMs?: number; log?: (event: Diagnostic) => void;
};

/** One bounded upstream request, no SDK, credentials of our own, or retries. */
export async function proxySupabaseAuth(request: Request): Promise<Response> {
  return handleAuthProxy(request, {
    projectUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  });
}

export async function handleAuthProxy(request: Request, dependencies: Dependencies): Promise<Response> {
  const started = performance.now();
  const suppliedId = request.headers.get("x-tps-auth-request-id");
  const requestId = suppliedId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedId)
    ? suppliedId : randomUUID();
  const log = dependencies.log ?? ((event: Diagnostic) => console.info("[auth-proxy]", event));
  let phase = "rejected";
  let upstreamStarted: number | null = null;
  const finish = (status: number, result: string, body: BodyInit | null, upstreamHeaders?: Headers) => {
    const headers = new Headers({
      "Cache-Control": "no-store, max-age=0", "CDN-Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "no-store", "Pragma": "no-cache",
      "X-Content-Type-Options": "nosniff", "X-TPS-Auth-Request-Id": requestId,
      "X-TPS-Auth-Result": result
    });
    for (const name of RESPONSE_HEADERS) {
      const value = upstreamHeaders?.get(name);
      if (value) headers.set(name, value);
    }
    const durationMs = Math.round(performance.now() - started);
    const upstreamMs = upstreamStarted === null ? null : Math.round(performance.now() - upstreamStarted);
    log({ event: "auth_proxy", requestId, phase, status, result, durationMs, upstreamMs });
    return new Response(request.method === "HEAD" ? null : body, { status, headers });
  };
  const fail = (status: number, result: string, headers: Record<string, string> = {}) => finish(status, result, JSON.stringify({
    error_code: `tps_auth_proxy_${result}`, message: "Authentication transport unavailable", request_id: requestId
  }), new Headers({ "content-type": "application/json", ...headers }));

  const url = new URL(request.url);
  const endpoint = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : "";
  // Exact raw pathname allowlist: no decoding, URL interpolation, admin, OAuth
  // redirects, GET verification tokens, arbitrary suffixes, or encoded slashes.
  const rule = Object.hasOwn(ENDPOINTS, endpoint) ? ENDPOINTS[endpoint] : undefined;
  if (!rule) return fail(404, "path_rejected");
  if (!rule.methods.includes(request.method)) return fail(405, "method_rejected", { allow: rule.methods.join(", ") });
  if (url.search.length > 4096 || Array.from(url.searchParams.keys()).some(key =>
    !rule.queries.includes(key) || url.searchParams.getAll(key).length !== 1)) return fail(400, "query_rejected");
  if (endpoint === "token" && !["password", "refresh_token", "pkce"].includes(url.searchParams.get("grant_type") ?? "")) {
    return fail(400, "query_rejected");
  }
  if (endpoint === "logout" && url.searchParams.has("scope") && !["global", "local", "others"].includes(url.searchParams.get("scope")!)) {
    return fail(400, "query_rejected");
  }
  phase = endpoint === "token" ? (url.searchParams.get("grant_type") === "password" ? "login"
    : url.searchParams.get("grant_type") === "refresh_token" ? "refresh" : "pkce")
    : endpoint === "user" ? (request.method === "PUT" ? "user_update" : "user_lookup")
    : endpoint === ".well-known/jwks.json" ? "jwks" : endpoint;

  let upstream: URL;
  try {
    const project = new URL(dependencies.projectUrl ?? "");
    // The only allowed upstream comes from the existing project configuration.
    // Reject local/TPS/custom destinations rather than risk a loop or SSRF.
    if (project.protocol !== "https:" || !/^[a-z0-9-]+\.supabase\.co$/.test(project.hostname)
      || project.port || project.username || project.password || project.pathname !== "/" || project.search || project.hash
      || !dependencies.anonKey) return fail(503, "configuration");
    upstream = new URL(`/auth/v1/${endpoint}${url.search}`, project);
  } catch { return fail(503, "configuration"); }
  // Do not permit a caller to select another project's API key. No service key
  // is read or injected. JWT authorization and all Auth checks stay upstream.
  if (request.headers.get("apikey") !== dependencies.anonKey) return fail(401, "key_rejected");
  const origin = request.headers.get("origin");
  if ((origin && origin !== url.origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    return fail(403, "origin_rejected");
  }
  const hasBody = request.method === "POST" || request.method === "PUT";
  if (hasBody && !/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return fail(415, "content_type_rejected");
  }
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) return fail(413, "body_too_large");
  if (request.headers.has("content-encoding")) return fail(415, "content_encoding_rejected");

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, dependencies.timeoutMs ?? TIMEOUT_MS);
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) controller.abort();
  try {
    const body = hasBody ? await readBounded(request.body, BODY_LIMIT, controller.signal) : undefined;
    const headers = new Headers();
    for (const name of REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    upstreamStarted = performance.now();
    // Origin is unchanged. Host is generated for the fixed upstream by fetch.
    // No TPS cookies/IP forwarding headers are copied: Auth uses bearer tokens
    // and anon keys cannot enable Supabase's trusted IP-forwarding mechanism.
    const response = await (dependencies.fetchImpl ?? fetch)(upstream, {
      method: request.method, headers, body, cache: "no-store", redirect: "manual",
      credentials: "omit", signal: controller.signal
    });
    // These JSON endpoints have no redirect workflow. Never follow a redirect
    // (especially a POST), expose Location, or accidentally leave the proxy.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return fail(502, "upstream_redirect");
    }
    const bytes = await readBounded(response.body, RESPONSE_LIMIT, controller.signal);
    return finish(response.status, response.status === 429 ? "upstream_429"
      : response.status >= 500 ? "upstream_5xx" : response.status >= 400 ? "upstream_4xx" : "ok",
    [204, 205, 304].includes(response.status) ? null : bytes, response.headers);
  } catch (error) {
    if (timedOut) return fail(504, "timeout");
    if (request.signal.aborted) return fail(499, "client_abort");
    if (error instanceof BodyLimitError) return fail(upstreamStarted === null ? 413 : 502,
      upstreamStarted === null ? "body_too_large" : "upstream_body_too_large");
    return fail(502, upstreamStarted === null ? "request_read" : "upstream_network");
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  }
}

class BodyLimitError extends Error {}

async function readBounded(stream: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Cancel body reads as well as fetch when the deadline/client abort fires.
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (done) break;
      size += value.byteLength;
      if (size > limit) { void reader.cancel().catch(() => {}); throw new BodyLimitError(); }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
