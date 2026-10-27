const test = require("node:test");
const assert = require("node:assert/strict");
const { createSupabaseFetch } = require("../lib/supabase/fetch.ts");
const { handleAuthProxy } = require("../lib/supabase/authProxy.server.ts");
const { compileComponent, flush } = require("./fixtures/componentHarness.js");

// Real locked SDK, fake browser storage/BroadcastChannel and fully intercepted
// HTTP. No localhost, accounts, external requests, email or database writes.
for (const mode of ["proxy", "direct"]) {
  test(`real SDK ${mode}: legacy session, reopen, rotation, cross-tab events, logout/account switch/password/recovery`, async () => {
    const originals = Object.fromEntries(["window", "document", "localStorage", "BroadcastChannel"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const store = new Map();
    const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
    const channels = new Set();
    class FakeBroadcastChannel {
      constructor(name) { this.name = name; this.listeners = []; channels.add(this); }
      addEventListener(_type, callback) { this.listeners.push(callback); }
      postMessage(data) {
        for (const channel of channels) if (channel !== this && channel.name === this.name) {
          queueMicrotask(() => channel.listeners.forEach(listener => listener({ data: structuredClone(data) })));
        }
      }
      close() { channels.delete(this); }
    }
    const origin = "https://tps.example.invalid";
    globalThis.window = { location: { href: `${origin}/`, hash: "", search: "" }, addEventListener() {}, removeEventListener() {} };
    globalThis.document = { visibilityState: "hidden" };
    globalThis.localStorage = storage;
    globalThis.BroadcastChannel = FakeBroadcastChannel;
    const { createClient } = require("@supabase/supabase-js");
    const clients = [];
    const projectUrl = "https://mock-project.supabase.co";
    const key = "sb-mock-project-auth-token";
    const anonKey = "mock-public-key";
    const upstreamCalls = [], browserCalls = [], logs = [];
    let sequence = 0;
    let currentUser = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "synthetic@example.invalid" };
    const accessToken = () => [
      Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
      Buffer.from(JSON.stringify({ sub: currentUser.id, exp: Math.floor(Date.now() / 1000) + 3600, mock: ++sequence })).toString("base64url"),
      Buffer.from("synthetic-not-a-signature").toString("base64url")
    ].join(".");
    const session = () => ({ access_token: accessToken(), refresh_token: `mock-refresh-${sequence}`, expires_in: 3600, token_type: "bearer", user: currentUser });
    const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    const upstream = async (input, init) => {
      const url = new URL(input);
      assert.equal(url.origin, projectUrl);
      assert.equal(new Headers(init.headers).get("apikey"), anonKey);
      const bodyText = typeof init.body === "string" ? init.body : init.body ? new TextDecoder().decode(init.body) : "";
      const body = bodyText ? JSON.parse(bodyText) : null;
      upstreamCalls.push({ path: url.pathname, method: init.method, grant: url.searchParams.get("grant_type"), body });
      if (url.pathname.endsWith("/token")) {
        if (body.email === "second@example.invalid") currentUser = { ...currentUser, id: "00000000-0000-4000-8000-000000000002" };
        return json(session());
      }
      if (url.pathname.endsWith("/verify")) return json(session());
      if (url.pathname.endsWith("/user")) return json(currentUser);
      assert.ok(url.pathname.endsWith("/logout") || url.pathname.endsWith("/recover"));
      return json({});
    };
    const browserFetch = async (input, init) => {
      const url = new URL(input, origin);
      browserCalls.push(url.toString());
      if (url.origin === projectUrl) return upstream(url, init);
      assert.equal(url.origin, origin);
      // Simulate the browser's automatically supplied Origin, not a new proxy
      // header or a user-controlled upstream URL.
      const headers = new Headers(init.headers);
      headers.set("origin", origin);
      return handleAuthProxy(new Request(url, { ...init, headers }), {
        projectUrl, anonKey, fetchImpl: upstream, log: event => logs.push(event)
      });
    };
    const load = transportMode => {
      const page = compileComponent("lib/supabase/client.ts", {
        "@supabase/supabase-js": { createClient: (...args) => { const client = createClient(...args); clients.push(client); return client; } },
        "./fetch.ts": { createSupabaseFetch: options => createSupabaseFetch({ ...options, fetchImpl: browserFetch }) }
      }, { window: {}, process: { env: { NEXT_PUBLIC_SUPABASE_URL: projectUrl, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
        ...(transportMode === undefined ? {} : { NEXT_PUBLIC_SUPABASE_AUTH_TRANSPORT: transportMode }) } } });
      return page;
    };
    try {
      // Seed the original, pre-proxy SDK layout via a direct-only client.
      const legacy = createClient(projectUrl, anonKey, { global: { fetch: browserFetch } });
      clients.push(legacy);
      await legacy.auth.initialize();
      const signedIn = await legacy.auth.signInWithPassword({ email: "synthetic@example.invalid", password: "unit-test-only" });
      assert.equal(signedIn.error, null);
      assert.ok(store.has(key));
      const oldSession = store.get(key);
      await legacy.auth.dispose();
      const previousCalls = browserCalls.length;

      // Omitted switch uses proxy by default; explicit direct is the rollback.
      const page = load(mode === "proxy" ? undefined : "direct");
      const client = page.createBrowserSupabase();
      assert.strictEqual(page.createBrowserSupabase(), client);
      await client.auth.initialize();
      assert.equal(client.auth.storageKey, key);
      assert.equal(client.auth.autoRefreshToken, true);
      assert.equal(client.auth.persistSession, true);
      assert.equal(client.auth.detectSessionInUrl, true);
      assert.equal(client.auth.url, `${projectUrl}/auth/v1`);
      assert.equal(client.realtimeUrl.origin, "wss://mock-project.supabase.co");
      assert.equal(client.storageUrl.origin, projectUrl);
      assert.equal(store.get(key), oldSession);
      assert.equal((await client.auth.getSession()).data.session.access_token, signedIn.data.session.access_token);
      assert.equal(browserCalls.length, previousCalls, "restoration does not need a password or a network request");
      assert.equal(client.auth.broadcastChannel.name, key);

      const tab = load(mode).createBrowserSupabase();
      await tab.auth.initialize();
      const tabEvents = [];
      tab.auth.onAuthStateChange((event, value) => tabEvents.push({ event, id: value?.user.id, token: value?.access_token }));
      await flush(); // Complete INITIAL_SESSION before advancing the fake expiry.
      const expired = JSON.parse(store.get(key));
      expired.expires_at = 1;
      store.set(key, JSON.stringify(expired));
      const beforeRefresh = upstreamCalls.length;
      await client.auth._autoRefreshTokenTick();
      await flush();
      assert.equal(upstreamCalls.length, beforeRefresh + 1);
      assert.equal(upstreamCalls.at(-1).grant, "refresh_token");
      const refreshed = (await client.auth.getSession()).data.session;
      assert.notEqual(refreshed.access_token, signedIn.data.session.access_token);
      assert.equal(JSON.parse(store.get(key)).refresh_token, refreshed.refresh_token);
      assert.equal((await tab.auth.getSession()).data.session.access_token, refreshed.access_token);
      assert.ok(tabEvents.some(event => event.event === "TOKEN_REFRESHED" && event.token === refreshed.access_token));

      // Closing/reopening reads the same namespace and rotated refresh token.
      const reopened = load(mode).createBrowserSupabase();
      const beforeReopen = browserCalls.length;
      await reopened.auth.initialize();
      assert.equal((await reopened.auth.getSession()).data.session.refresh_token, refreshed.refresh_token);
      assert.equal(browserCalls.length, beforeReopen);

      const beforeUpdate = upstreamCalls.length;
      assert.equal((await client.auth.updateUser({ password: "mock-new-password" })).error, null);
      assert.equal(upstreamCalls.length, beforeUpdate + 1);
      assert.equal(upstreamCalls.at(-1).method, "PUT");
      assert.equal(upstreamCalls.at(-1).body.password, "mock-new-password");
      assert.equal((await client.auth.resetPasswordForEmail("synthetic@example.invalid", { redirectTo: `${origin}/` })).error, null);
      assert.equal(upstreamCalls.at(-1).path, "/auth/v1/recover");
      assert.equal((await client.auth.verifyOtp({ token_hash: "mock-recovery-hash", type: "recovery" })).error, null);
      assert.equal(upstreamCalls.at(-1).path, "/auth/v1/verify");
      assert.equal((await client.auth.exchangeCodeForSession("mock-pkce-code")).error, null);
      assert.equal(upstreamCalls.at(-1).grant, "pkce");
      assert.equal(upstreamCalls.at(-1).body.auth_code, "mock-pkce-code");
      assert.equal((await client.auth.getUser()).error, null);

      const beforeLogout = upstreamCalls.length;
      assert.equal((await client.auth.signOut()).error, null);
      await flush();
      assert.equal(upstreamCalls.length, beforeLogout + 1);
      assert.equal(store.has(key), false);
      assert.equal((await tab.auth.getSession()).data.session, null);
      assert.ok(tabEvents.some(event => event.event === "SIGNED_OUT"));
      assert.equal((await client.auth.signInWithPassword({ email: "second@example.invalid", password: "unit-test-only" })).error, null);
      await flush();
      assert.equal((await tab.auth.getSession()).data.session.user.id, "00000000-0000-4000-8000-000000000002");
      assert.ok(tabEvents.some(event => event.event === "SIGNED_IN" && event.id.endsWith("2")));
      const allNewRequests = browserCalls.slice(previousCalls);
      assert.ok(allNewRequests.length > 0);
      assert.ok(allNewRequests.every(url => mode === "proxy" ? url.startsWith(`${origin}/api/supabase/auth/v1/`) : url.startsWith(`${projectUrl}/auth/v1/`)));
      assert.doesNotMatch(JSON.stringify(logs), /mock-refresh|unit-test-only|mock-new-password|synthetic@|mock-recovery/);
    } finally {
      for (const client of clients) await client.auth.dispose();
      for (const [name, descriptor] of Object.entries(originals)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  });
}
