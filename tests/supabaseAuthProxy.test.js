const test = require("node:test");
const assert = require("node:assert/strict");
const { handleAuthProxy } = require("../lib/supabase/authProxy.server.ts");
const { createSupabaseFetch } = require("../lib/supabase/fetch.ts");
const { compileComponent } = require("./fixtures/componentHarness.js");

const projectUrl = "https://mock-project.supabase.co";
const origin = "https://tps.example.invalid";
const prefix = "/api/supabase/auth/v1/";
const anonKey = "mock-public-key";
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", ...headers }
});
function fixture(overrides = {}) {
  const calls = [], events = [];
  const dependencies = {
    projectUrl, anonKey, log: event => events.push(event),
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return json({ mock: true }); },
    ...overrides
  };
  return { calls, events, dependencies,
    send(endpoint = "token?grant_type=password", init = {}) {
      return handleAuthProxy(new Request(`${origin}${prefix}${endpoint}`, {
        method: "POST", body: JSON.stringify({ email: "synthetic@example.invalid", password: "mock-password" }),
        ...init, headers: { apikey: anonKey, origin, "content-type": "application/json", ...init.headers }
      }), dependencies);
    }
  };
}

test("fixed upstream preserves bytes, query, method and Auth headers, never cookies/forwarded IP/Host", async () => {
  const f = fixture();
  const body = '{"refresh_token":"mock-refresh", "unchanged":true}';
  const id = "c2b46717-fdf5-419c-9767-fc6c4970eb6a";
  const response = await f.send("token?grant_type=refresh_token", { body, headers: {
    Authorization: "Bearer mock-access", cookie: "private-tps-cookie", host: "untrusted.invalid",
    "x-forwarded-for": "1.2.3.4", "sb-forwarded-for": "5.6.7.8", "x-tps-auth-request-id": id,
    "x-client-info": "supabase-js-web/2.110.0", "x-supabase-api-version": "2024-01-01"
  } });
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `${projectUrl}/auth/v1/token?grant_type=refresh_token`);
  const { init } = f.calls[0];
  assert.equal(init.method, "POST");
  assert.equal(new TextDecoder().decode(init.body), body);
  assert.equal(init.headers.get("authorization"), "Bearer mock-access");
  assert.equal(init.headers.get("apikey"), anonKey);
  assert.equal(init.headers.get("origin"), origin);
  assert.equal(init.headers.get("x-supabase-api-version"), "2024-01-01");
  assert.equal(init.headers.get("x-client-info"), "supabase-js-web/2.110.0");
  for (const name of ["cookie", "host", "x-forwarded-for", "sb-forwarded-for"]) assert.equal(init.headers.has(name), false);
  assert.equal(init.cache, "no-store");
  assert.equal(init.redirect, "manual");
  assert.equal(response.headers.get("x-tps-auth-request-id"), id);
  assert.equal(f.events[0].phase, "refresh");
  assert.equal(typeof f.events[0].upstreamMs, "number");
  assert.doesNotMatch(JSON.stringify(f.events), /mock-refresh|mock-access|mock-password|synthetic|cookie|1\.2\.3/);
});

for (const status of [200, 400, 401, 403, 429, 500, 503]) {
  test(`upstream ${status} is preserved without retry; body, version, retry-after remain intact and uncached`, async () => {
    let calls = 0;
    const f = fixture({ fetchImpl: async () => { calls++; return json({ code: "mock_upstream_code" }, status, {
      "retry-after": "30", "x-supabase-api-version": "2024-01-01",
      "cache-control": "public, max-age=3600", "set-cookie": "unsafe=mock", location: "https://other.invalid"
    }); } });
    const response = await f.send();
    assert.equal(calls, 1);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { code: "mock_upstream_code" });
    for (const name of ["cache-control", "cdn-cache-control", "vercel-cdn-cache-control"]) {
      assert.match(response.headers.get(name), /no-store/);
    }
    assert.equal(response.headers.get("retry-after"), "30");
    assert.equal(response.headers.get("x-supabase-api-version"), "2024-01-01");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("location"), null);
    assert.equal(f.events[0].result, status === 429 ? "upstream_429" : status >= 500 ? "upstream_5xx" : status >= 400 ? "upstream_4xx" : "ok");
  });
}

test("only explicit paths/methods/queries/grants accepted; rejects admin, arbitrary targets and encoded bypasses", async () => {
  for (const [endpoint, method, expected] of [
    ["admin/users", "POST", 404], ["authorize", "GET", 404], ["verify?token=private", "GET", 405],
    ["signup", "POST", 404], ["token/extra", "POST", 404], ["%74oken?grant_type=password", "POST", 404],
    ["token%2F..%2Fadmin", "POST", 404], ["https:%2F%2Fevil.invalid", "POST", 404],
    ["token?grant_type=password", "DELETE", 405], ["user", "PATCH", 405], ["user", "OPTIONS", 405],
    ["token?grant_type=password&url=https://evil.invalid", "POST", 400],
    ["token?grant_type=password&grant_type=refresh_token", "POST", 400],
    ["token?grant_type=client_credentials", "POST", 400], ["token", "POST", 400],
    ["logout?scope=bad", "POST", 400], ["user?access_token=private", "GET", 400]
  ]) {
    const f = fixture();
    const response = await f.send(endpoint, { method, body: method === "GET" ? undefined : "{}" });
    assert.equal(response.status, expected, `${method} ${endpoint}`);
    if (expected === 405) assert.ok(response.headers.get("allow"));
    assert.equal(f.calls.length, 0);
    assert.match(response.headers.get("cache-control"), /no-store/);
  }
});

test("correct logout, password update, recovery, PKCE, verification, user and JWKS requests pass exactly once", async () => {
  for (const [endpoint, method, phase] of [
    ["logout?scope=global", "POST", "logout"], ["user", "PUT", "user_update"],
    ["recover?redirect_to=https%3A%2F%2Ftps.example.invalid%2F", "POST", "recover"],
    ["token?grant_type=pkce", "POST", "pkce"], ["verify", "POST", "verify"],
    ["user", "GET", "user_lookup"], ["reauthenticate", "GET", "reauthenticate"],
    [".well-known/jwks.json", "GET", "jwks"]
  ]) {
    const f = fixture();
    if (phase === "logout") f.dependencies.fetchImpl = async (url, init) => {
      f.calls.push({ url: String(url), init });
      return new Response(null, { status: 204 });
    };
    const response = await f.send(endpoint, { method, body: method === "GET" ? undefined : "{}" });
    assert.equal(response.status, phase === "logout" ? 204 : 200);
    if (phase === "logout") assert.equal(await response.text(), "");
    assert.equal(f.calls.length, 1);
    assert.equal(f.events[0].phase, phase);
    assert.equal(f.calls[0].url, `${projectUrl}/auth/v1/${endpoint}`);
  }
});

test("fails closed for upstream loops, non-project URLs, API key and cross-site abuse", async () => {
  for (const bad of [origin, "http://mock.supabase.co", "https://supabase.co.evil.invalid", "https://mock.supabase.co/auth/v1", "https://user:pass@mock.supabase.co"]) {
    const f = fixture({ projectUrl: bad });
    assert.equal((await f.send()).status, 503);
    assert.equal(f.calls.length, 0);
  }
  for (const headers of [{ apikey: "other-project-key" }, { origin: "https://evil.invalid" }, { "sec-fetch-site": "cross-site" }]) {
    const f = fixture();
    assert.ok([401, 403].includes((await f.send(undefined, { headers })).status));
    assert.equal(f.calls.length, 0);
  }
});

test("bounded request bodies including chunked/lying content-length, JSON only", async () => {
  for (const [body, headers, status] of [
    ["{}", { "content-length": "65537" }, 413], ["x".repeat(65537), { "content-length": "1" }, 413],
    ["{}", { "content-type": "text/plain" }, 415], ["{}", { "content-encoding": "gzip" }, 415]
  ]) {
    const f = fixture();
    assert.equal((await f.send(undefined, { body, headers })).status, status);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(65537)); c.close(); } });
  assert.equal((await f.send(undefined, { body, duplex: "half" })).status, 413);
  assert.equal(f.calls.length, 0);
});

test("network failure, timeout while connecting/reading and excessive response are safe distinct failures", async () => {
  for (const [fetchImpl, expectedStatus, expectedResult] of [
    [async () => { throw new Error("private-mock-token-and-url"); }, 502, "upstream_network"],
    [(_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))), 504, "timeout"],
    [async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } })), 504, "timeout"],
    [async () => new Response(new Uint8Array(1024 * 1024 + 1)), 502, "upstream_body_too_large"],
    [async () => new Response(null, { status: 307, headers: { location: "https://evil.invalid" } }), 502, "upstream_redirect"]
  ]) {
    let calls = 0;
    const f = fixture({ timeoutMs: 10, fetchImpl: (...args) => { calls++; return fetchImpl(...args); } });
    const response = await f.send();
    assert.equal(response.status, expectedStatus);
    assert.equal(calls, 1);
    assert.equal(f.events[0].result, expectedResult);
    assert.doesNotMatch(JSON.stringify([await response.json(), f.events]), /private-mock|evil\.invalid/);
  }
});

test("slow request body deadline and pre-aborted clients do not submit upstream", async () => {
  const f = fixture({ timeoutMs: 10 });
  assert.equal((await f.send(undefined, { body: new ReadableStream({ start() {} }), duplex: "half" })).status, 504);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await f.send(undefined, { signal: controller.signal })).status, 499);
  assert.equal(f.calls.length, 0);
});

test("browser transport proxies only exact project Auth, direct rollback and non-Auth stay unchanged", async () => {
  for (const mode of ["proxy", "direct"]) {
    const calls = [];
    const request = createSupabaseFetch({ authProxy: { projectUrl, mode }, fetchImpl: async (input, init) => {
      calls.push({ input, init }); return json({});
    } });
    const input = `${projectUrl}/auth/v1/token?grant_type=refresh_token`;
    await request(input, { method: "POST", body: '{"refresh_token":"mock"}', headers: { Authorization: "Bearer mock" } });
    assert.equal(calls[0].input, mode === "proxy" ? `${prefix}token?grant_type=refresh_token` : input);
    assert.equal(calls[0].init.body, '{"refresh_token":"mock"}');
    assert.equal(calls[0].init.method, "POST");
    for (const url of [`${projectUrl}/rest/v1/profiles`, `${projectUrl}/storage/v1/object/mock`, `${projectUrl}/functions/v1/mock`, "https://other.supabase.co/auth/v1/user", `${projectUrl}/auth/v10/user`, "/api/unrelated"]) {
      await request(url);
      assert.equal(calls.at(-1).input, url);
    }
  }
  assert.throws(() => createSupabaseFetch({ authProxy: { projectUrl, mode: "automatic" } }), /Invalid NEXT_PUBLIC/);
});

test("Request input retains method/body/headers/signal through browser URL substitution", async () => {
  const { createSupabaseFetch: create } = compileComponent("lib/supabase/fetch.ts", {}, { URL, window: { location: { origin } } });
  const controller = new AbortController();
  const incoming = new Request(`${projectUrl}/auth/v1/user`, { method: "PUT", body: '{"password":"mock-new"}', headers: { authorization: "Bearer mock" }, signal: controller.signal });
  const request = create({ authProxy: { projectUrl, mode: "proxy" }, fetchImpl: async (input, init) => {
    assert.equal(input.url, `${origin}${prefix}user`);
    assert.equal(input.method, "PUT");
    assert.equal(await input.text(), '{"password":"mock-new"}');
    assert.equal(init.headers.get("authorization"), "Bearer mock");
    controller.abort();
    assert.equal(input.signal.aborted, true);
    return json({});
  } });
  await request(incoming);
});

test("neither transport mode retries Auth operations or falls back after POST failure; safe browser diagnoses", async () => {
  const events = [];
  const { createSupabaseFetch: create } = compileComponent("lib/supabase/fetch.ts", {}, {
    URL, crypto: require("node:crypto").webcrypto, console: { warn: (...args) => events.push(args) }
  });
  for (const mode of ["proxy", "direct"]) {
    for (const method of ["GET", "POST", "PUT"]) {
      for (const failure of ["network", 429, 503]) {
        let calls = 0;
        const request = create({ authProxy: { projectUrl, mode }, fetchImpl: async () => {
          calls++;
          if (failure === "network") throw new TypeError("private-mock-secret");
          return json({}, failure, { "x-tps-auth-result": failure === 429 ? "upstream_429" : "upstream_5xx" });
        } });
        if (failure === "network") await assert.rejects(request(`${projectUrl}/auth/v1/user`, { method }));
        else assert.equal((await request(`${projectUrl}/auth/v1/user`, { method })).status, failure);
        assert.equal(calls, 1);
      }
    }
  }
  for (const [result, expected] of [["timeout", "TIMEOUT"], ["upstream_network", "UPSTREAM-NET"], ["upstream_4xx", "4XX"]]) {
    await create({ authProxy: { projectUrl, mode: "proxy" }, fetchImpl: async () => json({}, 502, { "x-tps-auth-result": result }) })(`${projectUrl}/auth/v1/token`, { method: "POST" });
    assert.equal(events.at(-1)[1].code, `TPS-AUTH-PROXY-${expected}`);
  }
  assert.ok(events.some(event => event[1].code === "TPS-AUTH-PROXY-ENTRY"));
  assert.doesNotMatch(JSON.stringify(events), /private-mock|password|authorization|supabase\.co/);
});

test("route explicitly pins Node/syd1 and uncached dynamic behavior", () => {
  const route = compileComponent("app/api/supabase/auth/v1/[...path]/route.ts", {
    "@/lib/supabase/authProxy.server": { proxySupabaseAuth: () => {} }
  });
  assert.equal(route.runtime, "nodejs");
  assert.equal(route.preferredRegion, "syd1");
  assert.equal(route.dynamic, "force-dynamic");
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) assert.equal(typeof route[method], "function");
});
