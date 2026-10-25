const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");
const credentials = require("../lib/accountCredentials.ts");
const verification = require("../lib/accountVerification.ts");
const permissions = require("../lib/accountPermissions.ts");

// Compile the actual components/routes with strictly mocked boundaries. No
// Supabase SDK, real account, network connection, browser, or database is used.
function compile(file, mocks, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
  const js = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const exported = {};
  vm.runInNewContext(js, {
    exports: exported, console, Response, Request, AbortController, setTimeout, clearTimeout,
    URLSearchParams,
    require(name) {
      if (!Object.hasOwn(mocks, name)) throw new Error(`Unmocked dependency: ${name}`);
      return mocks[name];
    },
    ...globals
  }, { filename: file });
  return exported;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const session = () => ({ access_token: "mock-access-value", user: { id: "mock-user" } });
const account = (role = "student") => ({ userId: "mock-user", role, displayName: "Mock", defaultRoute: permissions.defaultRouteForRole(role) });
const signedIn = () => ({ data: { user: session().user, session: session() }, error: null });
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

function hookHarness() {
  const slots = [];
  let index = 0;
  let effects = [];
  const react = {
    useState(initial) {
      const i = index++;
      if (!slots[i]) slots[i] = { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, next => { slots[i].value = typeof next === "function" ? next(slots[i].value) : next; }];
    },
    useRef(value) {
      const i = index++;
      if (!slots[i]) slots[i] = { current: value };
      return slots[i];
    },
    useEffect(effect, deps) {
      const i = index++;
      if (!slots[i] || deps.some((value, j) => value !== slots[i].deps[j])) {
        const previous = slots[i];
        slots[i] = { deps };
        effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = effect(); });
      }
    },
    createContext: () => ({ Provider: "provider" }),
    useContext: () => null
  };
  return {
    react,
    render(Component, props = {}) {
      index = 0;
      const tree = Component(props);
      const pending = effects;
      effects = [];
      pending.forEach(effect => effect());
      return tree;
    },
    unmount() { slots.forEach(slot => slot?.cleanup?.()); }
  };
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...nodes(tree.props?.children)];
}
const text = tree => {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree === null || tree === undefined || typeof tree === "boolean") return "";
  return typeof tree === "object" ? text(tree.props?.children) : String(tree);
};
const find = (tree, predicate) => {
  const value = nodes(tree).find(predicate);
  assert.ok(value, "expected UI element");
  return value;
};

function clientFixture(kind = "login") {
  const h = hookHarness();
  const diagnostics = [];
  const routes = [];
  const requests = [];
  const authListeners = new Set();
  let signIns = 0;
  let signOuts = 0;
  const f = {
    signIn: async () => signedIn(),
    getSession: async () => ({ data: { session: kind === "gate" ? session() : null }, error: null }),
    fetch: async () => json(200, account()),
    createError: null,
    search: ""
  };
  const router = {
    push: route => routes.push(["push", route]),
    replace: route => routes.push(["replace", route]),
    refresh: () => routes.push(["refresh"])
  };
  const mockedCredentials = { ...credentials, reportAccountFailure: failure => diagnostics.push(failure) };
  const mocks = {
    react: h.react,
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    "next/navigation": { useRouter: () => router },
    "next/image": { default: "img" },
    "next/link": { default: "a" },
    "lucide-react": {},
    "@/components/shared/ConfirmDialog": { ConfirmDialog: "dialog", ModalShell: "modal" },
    "@/lib/accountCredentials": mockedCredentials,
    "@/lib/accountPermissions": permissions,
    "@/lib/accountVerification": {
      ...verification,
      fetchVerifiedAccount: (token, userId) => verification.fetchVerifiedAccount(token, userId, {
        fetchImpl: async (url, init) => { requests.push({ url, method: init?.method ?? "GET" }); return f.fetch(url, init); }
      })
    },
    "@/lib/accountIdentifier": require("../lib/accountIdentifier.ts"),
    "@/lib/studentNavigation": require("../lib/studentNavigation.ts"),
    "@/lib/supabase/client": {
      createBrowserSupabase: () => {
        if (f.createError) throw f.createError;
        return { auth: {
          onAuthStateChange: callback => {
            authListeners.add(callback);
            return { data: { subscription: { unsubscribe: () => authListeners.delete(callback) } } };
          },
          getSession: () => f.getSession(),
          signInWithPassword: async () => { signIns++; return f.signIn(); },
          signOut: async () => { signOuts++; throw new Error("No automatic sign-out allowed"); }
        } };
      }
    }
  };
  const component = kind === "gate"
    ? compile("components/RoleGate.tsx", mocks, { window: { sessionStorage: {
      // A legacy valid-looking cached account must never authorize children.
      getItem: () => JSON.stringify({ account: account(), cachedAt: Date.now() }), removeItem: () => {}
    } } }).RoleGate
    : compile("components/LoginPanel.tsx", mocks, { window: { location: { get search() { return f.search; } } } }).LoginPanel;
  let tree;
  const props = kind === "gate" ? { area: "student", children: "protected-content" } : {};
  return Object.assign(f, {
    diagnostics, routes, requests, props,
    render() { tree = h.render(component, props); return tree; },
    submit() { return find(tree, node => node.type === "form").props.onSubmit({ preventDefault() {} }); },
    button() { return find(tree, node => node.type === "button" && node.props.type === "submit"); },
    error() { return nodes(tree).find(node => node.props?.role === "alert")?.props.children ?? ""; },
    retry() { find(tree, node => node.type === "button" && text(node) === "重新验证").props.onClick(); },
    signIns: () => signIns,
    signOuts: () => signOuts,
    emitAuth(event, value) { for (const listener of authListeners) listener(event, value); },
    subscriptions: () => authListeners.size,
    unmount: () => h.unmount()
  });
}

for (const role of ["student", "teacher", "admin"]) {
  test(`successful ${role} login keeps the existing destination and restores button`, async () => {
    const f = clientFixture();
    f.fetch = async () => json(200, account(role));
    f.render();
    await f.submit();
    f.render();
    assert.deepEqual(f.routes, [["push", permissions.defaultRouteForRole(role)], ["refresh"]]);
    assert.equal(f.button().props.disabled, false);
    assert.equal(f.signIns(), 1);
    assert.equal(f.signOuts(), 0);
  });
}

const loginFailures = [
  ["invalid password", { name: "AuthApiError", code: "invalid_credentials", status: 400, message: "Invalid login credentials" }, "LOGIN_INVALID_CREDENTIALS", /账号或密码错误/, 400],
  ["network Load failed", { name: "AuthRetryableFetchError", status: 0, message: "Load failed" }, "LOGIN_NETWORK_ERROR", /检查网络/, null],
  ["HTTP 429", { name: "AuthApiError", status: 429, code: "over_request_rate_limit" }, "LOGIN_RATE_LIMITED", /稍后重试/, 429],
  ["HTTP 503", { name: "AuthRetryableFetchError", status: 503 }, "LOGIN_SERVICE_UNAVAILABLE", /服务暂时不可用/, 503],
  ["Auth banned", { name: "AuthApiError", status: 400, code: "user_banned" }, "ACCOUNT_DISABLED", /停用/, 400]
];
for (const [label, error, code, message, status] of loginFailures) {
  test(`login ${label} is classified, not retried, and can be attempted again`, async () => {
    const f = clientFixture();
    f.signIn = async () => ({ data: { user: null, session: null }, error });
    f.render();
    await f.submit();
    f.render();
    assert.match(f.error(), message);
    assert.equal(f.diagnostics.at(-1).code, code);
    assert.equal(f.diagnostics.at(-1).status, status);
    assert.equal(f.diagnostics.at(-1).stage, "password_sign_in");
    assert.equal(f.button().props.disabled, false);
    assert.equal(f.signIns(), 1);
    assert.equal(f.requests.length, 0);
    assert.equal(f.routes.length, 0);
    assert.equal(f.signOuts(), 0);
    f.signIn = async () => signedIn();
    await f.submit();
    f.render();
    assert.equal(f.signIns(), 2);
    assert.equal(f.routes[0][1], "/student");
  });
}

for (const [label, fetchImpl, code] of [
  ["network", async () => { throw new TypeError("Load failed"); }, "ACCOUNT_VERIFICATION_UNAVAILABLE"],
  ["HTTP 500", async () => json(500, { code: "ACCOUNT_CONFIGURATION_ERROR" }), "ACCOUNT_VERIFICATION_UNAVAILABLE"],
  ["HTTP 503", async () => json(503, {}), "ACCOUNT_VERIFICATION_UNAVAILABLE"],
  ["disabled", async () => json(403, { code: "ACCOUNT_DISABLED" }), "ACCOUNT_DISABLED"],
  ["configuration", async () => json(403, { code: "ACCOUNT_CONFIGURATION_ERROR" }), "ACCOUNT_CONFIGURATION_ERROR"],
  ["invalid session", async () => json(401, {}), "ACCOUNT_UNAUTHENTICATED"],
  ["malformed success", async () => json(200, { role: "admin", defaultRoute: "https://invalid.example" }), "ACCOUNT_VERIFICATION_UNAVAILABLE"],
  ["body read rejection", async () => ({ ok: true, status: 200, json: async () => { throw new TypeError("Load failed"); } }), "ACCOUNT_VERIFICATION_UNAVAILABLE"]
]) {
  test(`post-login account ${label}: deny access, no sign-out, unlock button`, async () => {
    const f = clientFixture();
    f.fetch = fetchImpl;
    f.render();
    await f.submit();
    f.render();
    assert.equal(f.diagnostics.at(-1).code, code);
    assert.equal(f.diagnostics.at(-1).stage, "account_verification");
    assert.equal(f.signOuts(), 0);
    assert.equal(f.signIns(), 1);
    assert.equal(f.requests.length, 1);
    assert.equal(f.routes.length, 0);
    assert.equal(f.button().props.disabled, false);
    if (code === "ACCOUNT_VERIFICATION_UNAVAILABLE") assert.doesNotMatch(f.error(), /账号配置异常/);
    f.fetch = async () => json(200, account());
    await f.submit();
    assert.equal(f.routes[0][1], "/student");
  });
}

test("synchronous repeated submit events share neither a second POST nor a second verification", async () => {
  const f = clientFixture();
  const pendingSignIn = deferred();
  const pendingVerification = deferred();
  f.signIn = () => pendingSignIn.promise;
  f.fetch = () => pendingVerification.promise;
  f.render();
  const first = f.submit();
  await f.submit();
  assert.equal(f.signIns(), 1);
  pendingSignIn.resolve(signedIn());
  await flush();
  await f.submit();
  f.render();
  assert.equal(f.signIns(), 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.button().props.disabled, true);
  pendingVerification.resolve(json(200, account()));
  await first;
  f.render();
  assert.equal(f.button().props.disabled, false);
});

test("thrown SDK errors and synchronous client-creation errors cannot leave loading latched", async () => {
  for (const createError of [null, new Error("mock configuration failure")]) {
    const f = clientFixture();
    f.createError = createError;
    f.signIn = async () => { throw new TypeError("Load failed"); };
    f.render();
    await f.submit();
    await flush();
    f.render();
    assert.equal(f.button().props.disabled, false);
    assert.equal(f.routes.length, 0);
    f.createError = null;
    f.signIn = async () => signedIn();
    await f.submit();
    assert.equal(f.routes[0][1], "/student");
  }
});

test("existing-session verification catches network errors and does not revoke sessions", async () => {
  for (const failSessionLookup of [false, true]) {
    const f = clientFixture();
    f.getSession = async () => {
      if (failSessionLookup) throw new TypeError("Load failed");
      return { data: { session: session() }, error: null };
    };
    f.fetch = async () => { throw new TypeError("Load failed"); };
    f.render();
    await flush();
    f.render();
    assert.match(f.error(), /暂时无法验证账号/);
    assert.equal(f.routes.length, 0);
    assert.equal(f.signOuts(), 0);
    assert.equal(f.button().props.disabled, false);
  }
});

test("a stale automatic redirect cannot override a later explicit login failure", async () => {
  const f = clientFixture();
  const pending = deferred();
  f.getSession = async () => ({ data: { session: session() }, error: null });
  f.fetch = () => pending.promise;
  f.render();
  await flush();
  f.signIn = async () => ({ data: { user: null, session: null }, error: { code: "invalid_credentials" } });
  await f.submit();
  pending.resolve(json(200, account()));
  await flush();
  assert.equal(f.routes.length, 0);
});

test("safe student returnTo works for both fresh and existing sessions", async () => {
  for (const existing of [false, true]) {
    const f = clientFixture();
    f.search = "?returnTo=%2Fstudent%2Fhome";
    if (existing) f.getSession = async () => ({ data: { session: session() }, error: null });
    f.render();
    if (existing) await flush(); else await f.submit();
    assert.equal(f.routes[0][1], "/student/home");
  }
});

test("RoleGate denies cached identity on network failure, then recovers without a login POST", async () => {
  const f = clientFixture("gate");
  f.fetch = async () => { throw new TypeError("Load failed"); };
  assert.doesNotMatch(text(f.render()), /protected-content/);
  await flush();
  let tree = f.render();
  assert.doesNotMatch(text(tree), /protected-content|当前账号没有有效身份/);
  assert.match(text(tree), /暂时无法验证账号/);
  f.fetch = async () => json(200, account());
  f.retry();
  assert.doesNotMatch(text(f.render()), /protected-content/);
  await flush();
  tree = f.render();
  assert.match(text(tree), /protected-content/);
  assert.equal(f.signIns(), 0);
  assert.equal(f.signOuts(), 0);
});

test("RoleGate keeps disabled/configuration/unknown-role accounts outside protected children", async () => {
  for (const response of [
    () => json(403, { code: "ACCOUNT_DISABLED" }),
    () => json(403, { code: "ACCOUNT_CONFIGURATION_ERROR" }),
    () => json(200, { ...account(), role: "unexpected" })
  ]) {
    const f = clientFixture("gate");
    f.fetch = async () => response();
    f.render();
    await flush();
    assert.doesNotMatch(text(f.render()), /protected-content/);
    assert.equal(f.signOuts(), 0);
  }
});

test("RoleGate preserves role permissions and rejects a stale verification result after area change", async () => {
  const f = clientFixture("gate");
  f.render();
  await flush();
  assert.match(text(f.render()), /protected-content/);
  f.props.area = "teacher";
  assert.doesNotMatch(text(f.render()), /protected-content/);
  await flush();
  assert.doesNotMatch(text(f.render()), /protected-content/);
  assert.deepEqual(f.routes, [["replace", "/student"]]);
});

function serverFixture() {
  const f = {
    claims: { data: { claims: { sub: "mock-user" } }, error: null },
    profile: { data: { role: "student", is_active: true }, error: null, status: 200 },
    claimThrow: null,
    profileThrow: null,
    profileReads: 0,
    diagnostics: []
  };
  const auth = compile("lib/auth.ts", {
    "@/lib/supabase/server": { createAnonSupabase: () => ({
      auth: { getClaims: async () => { if (f.claimThrow) throw f.claimThrow; return f.claims; } },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => {
        f.profileReads++;
        if (f.profileThrow) throw f.profileThrow;
        return f.profile;
      } }) }) })
    }) },
    "@/lib/supabase/jwks.server": { getCachedSupabaseJwks: async () => null },
    "@/lib/userDisplayName": { getPreferredUserDisplayName: () => "Mock" },
    "@/lib/accountPermissions": permissions,
    "./accountCredentials.ts": credentials,
    "./accountVerification.ts": verification
  });
  const route = compile("app/api/account/me/route.ts", {
    "next/server": { NextResponse: { json: (value, init) => new Response(JSON.stringify(value), {
      ...init, headers: { "Content-Type": "application/json", ...init?.headers }
    }) } },
    "@/lib/auth": auth,
    "@/lib/accountCredentials": { ...credentials, reportAccountFailure: failure => f.diagnostics.push(failure) },
    "@/lib/accountVerification": verification
  });
  f.get = async (authenticated = true) => route.GET(new Request("https://example.invalid/api/account/me", {
    headers: authenticated ? { Authorization: "Bearer mock-access-value" } : {}
  }));
  return f;
}

test("account endpoint preserves all role routes and denies missing credentials", async () => {
  const f = serverFixture();
  assert.equal((await f.get(false)).status, 401);
  assert.equal(f.profileReads, 0);
  for (const role of ["student", "teacher", "admin"]) {
    f.profile.data.role = role;
    const response = await f.get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal((await response.json()).defaultRoute, permissions.defaultRouteForRole(role));
  }
});

for (const [label, setup, status, code] of [
  ["invalid JWT", f => { f.claims.error = { name: "AuthInvalidJwtError" }; }, 401, "ACCOUNT_UNAUTHENTICATED"],
  ["Auth 429", f => { f.claims.error = { name: "AuthApiError", status: 429, code: "over_request_rate_limit" }; }, 503, "ACCOUNT_VERIFICATION_UNAVAILABLE"],
  ["Auth network", f => { f.claimThrow = new TypeError("fetch failed"); }, 503, "ACCOUNT_VERIFICATION_UNAVAILABLE"],
  ["Auth 503", f => { f.claims.error = { name: "AuthRetryableFetchError", status: 503 }; }, 503, "ACCOUNT_VERIFICATION_UNAVAILABLE"],
  ["unknown Auth error", f => { f.claimThrow = new Error("mock-internal-sensitive-detail"); }, 500, "ACCOUNT_VERIFICATION_FAILED"],
  ["profile missing", f => { f.profile.data = null; }, 403, "ACCOUNT_CONFIGURATION_ERROR"],
  ["invalid role", f => { f.profile.data.role = "unexpected"; }, 403, "ACCOUNT_CONFIGURATION_ERROR"],
  ["disabled profile", f => { f.profile.data.is_active = false; }, 403, "ACCOUNT_DISABLED"],
  ["profile 429", f => { f.profile.error = { code: "over_request_rate_limit" }; f.profile.status = 429; }, 503, "ACCOUNT_VERIFICATION_UNAVAILABLE"],
  ["profile unavailable", f => { f.profile.error = { code: "PGRST002" }; f.profile.status = 503; }, 503, "ACCOUNT_VERIFICATION_UNAVAILABLE"],
  ["profile timeout", f => { f.profile.error = { code: "57014" }; f.profile.status = 500; }, 503, "ACCOUNT_VERIFICATION_UNAVAILABLE"],
  ["profile fetch error", f => { f.profile.error = { message: "TypeError: fetch failed" }; f.profile.status = 0; }, 503, "ACCOUNT_VERIFICATION_UNAVAILABLE"],
  ["unknown profile error", f => { f.profile.error = { code: "mock-private-value" }; f.profile.status = 400; }, 500, "ACCOUNT_VERIFICATION_FAILED"],
  ["thrown profile error", f => { f.profileThrow = new Error("mock-private-value"); }, 500, "ACCOUNT_VERIFICATION_FAILED"]
]) {
  test(`account endpoint ${label} returns ${status}/${code}, never a false permanent configuration error`, async () => {
    const f = serverFixture();
    setup(f);
    const response = await f.get();
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = await response.json();
    assert.equal(body.code, code);
    assert.equal(body.userId, undefined);
    assert.equal(body.defaultRoute, undefined);
    assert.equal(f.diagnostics.at(-1).code, code);
    assert.doesNotMatch(JSON.stringify([body, f.diagnostics]), /mock-private-value|mock-internal-sensitive-detail|mock-access-value/);
  });
}

test("diagnostics contain only safe primitive stage/status/type/code, never raw error extras", () => {
  const events = [];
  const previous = console.warn;
  console.warn = (...args) => events.push(args);
  try {
    const error = { name: "mock-private-name", code: "mock-private-code", status: 0,
      message: "Load failed", password: "mock-private-password", Authorization: "mock-private-authorization",
      session: { access_token: "mock-private-token" } };
    const failure = credentials.classifyLoginError(error);
    credentials.reportAccountFailure({ ...failure, error });
    assert.equal(events[0][1].status, null);
    assert.equal(events[0][1].code, "LOGIN_NETWORK_ERROR");
    assert.deepEqual(Object.keys(events[0][1]).sort(), ["code", "errorCode", "errorType", "stage", "status"]);
    assert.doesNotMatch(JSON.stringify(events), /mock-private/);
  } finally { console.warn = previous; }
});

test("account GET timeout is bounded and classified without claiming an HTTP status", async () => {
  const result = await verification.fetchVerifiedAccount("mock-access-value", "mock-user", {
    timeoutMs: 1,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "ACCOUNT_VERIFICATION_UNAVAILABLE");
  assert.equal(result.failure.errorType, "TimeoutError");
  assert.equal(result.failure.status, null);
});

test("existing-session auto-redirect preserves all three role destinations", async () => {
  for (const role of ["student", "teacher", "admin"]) {
    const f = clientFixture();
    f.getSession = async () => ({ data: { session: session() }, error: null });
    f.fetch = async () => json(200, account(role));
    f.render();
    await flush();
    assert.deepEqual(f.routes, [["replace", permissions.defaultRouteForRole(role)]]);
    assert.equal(f.signIns(), 0);
    assert.equal(f.signOuts(), 0);
  }
});

test("existing-session HTTP 503 or disabled account cannot auto-redirect into the system", async () => {
  for (const [status, code] of [[503, "ACCOUNT_VERIFICATION_UNAVAILABLE"], [403, "ACCOUNT_DISABLED"]]) {
    const f = clientFixture();
    f.getSession = async () => ({ data: { session: session() }, error: null });
    f.fetch = async () => json(status, { code });
    f.render();
    await flush();
    f.render();
    assert.equal(f.diagnostics.at(-1).code, code);
    assert.equal(f.routes.length, 0);
    assert.equal(f.signOuts(), 0);
  }
});

test("RoleGate handles both returned and rejected session lookup errors with a retry", async () => {
  for (const rejected of [false, true]) {
    const f = clientFixture("gate");
    f.getSession = async () => {
      if (rejected) throw new TypeError("Load failed");
      return { data: { session: null }, error: { name: "AuthRetryableFetchError", status: 0, message: "Load failed" } };
    };
    f.render();
    await flush();
    assert.doesNotMatch(text(f.render()), /protected-content/);
    assert.equal(f.diagnostics.at(-1).code, "ACCOUNT_VERIFICATION_UNAVAILABLE");
    assert.equal(f.routes.length, 0);
    f.getSession = async () => ({ data: { session: session() }, error: null });
    f.retry();
    f.render();
    await flush();
    assert.match(text(f.render()), /protected-content/);
  }
});

test("RoleGate HTTP 503 recovery does not depend on a cached account or page reload", async () => {
  const f = clientFixture("gate");
  f.fetch = async () => json(503, { code: "ACCOUNT_VERIFICATION_UNAVAILABLE" });
  f.render();
  await flush();
  assert.doesNotMatch(text(f.render()), /protected-content|账号配置异常/);
  f.fetch = async () => json(200, account());
  f.retry();
  f.render();
  await flush();
  assert.match(text(f.render()), /protected-content/);
  assert.equal(f.signIns(), 0);
});

test("RoleGate never accepts a verification response for a different session user", async () => {
  const f = clientFixture("gate");
  f.fetch = async () => json(200, { ...account("admin"), userId: "another-mock-user" });
  f.render();
  await flush();
  assert.doesNotMatch(text(f.render()), /protected-content/);
  assert.equal(f.diagnostics.at(-1).code, "ACCOUNT_VERIFICATION_UNAVAILABLE");
});

test("unmounted automatic checks do not navigate or report late failures", async () => {
  for (const kind of ["login", "gate"]) {
    const f = clientFixture(kind);
    const pending = deferred();
    f.getSession = () => pending.promise;
    f.render();
    f.unmount();
    pending.reject(new TypeError("Load failed"));
    await flush();
    assert.equal(f.routes.length, 0);
    assert.equal(f.diagnostics.length, 0);
  }
});

test("acceptance: login UI exposes safe phase/category/status codes without developer tools", async () => {
  for (const [error, expected] of [
    [{ name: "AuthRetryableFetchError", status: 0, message: "Load failed" }, "TPS-PW-NET-NA"],
    [{ name: "AuthApiError", status: 429, code: "over_request_rate_limit" }, "TPS-PW-RATE-429"],
    [{ name: "AuthApiError", status: 400, code: "invalid_credentials" }, "TPS-PW-CRED-400"]
  ]) {
    const f = clientFixture();
    f.signIn = async () => ({ data: { user: null, session: null }, error: {
      ...error, password: "private-mock-password", session: { access_token: "private-mock-token" }
    } });
    f.render();
    await f.submit();
    const tree = f.render();
    const diagnostic = find(tree, node => node.props?.["data-testid"] === "account-diagnostic");
    assert.match(text(diagnostic), /反馈管理员/);
    assert.ok(text(diagnostic).includes(expected));
    assert.doesNotMatch(text(diagnostic), /private-mock|mock-user|mock-access-value|Load failed/);
    assert.equal(f.routes.length, 0);
    assert.equal(f.signOuts(), 0);
  }
});

test("acceptance: existing-session and account-verification UI diagnostics identify distinct phases", async () => {
  for (const [phase, expected] of [["session", "TPS-SS-VERIFY-NA"], ["account", "TPS-AV-VERIFY-503"]]) {
    const f = clientFixture();
    f.getSession = async () => {
      if (phase === "session") throw new TypeError("Load failed");
      return { data: { session: session() }, error: null };
    };
    f.fetch = async () => json(503, {});
    f.render();
    await flush();
    const tree = f.render();
    assert.ok(text(find(tree, node => node.props?.["data-testid"] === "account-diagnostic")).includes(expected));
    assert.equal(f.routes.length, 0);
  }
});

test("acceptance: a new login attempt clears the previous visible diagnostic", async () => {
  const f = clientFixture();
  f.signIn = async () => ({ data: { user: null, session: null }, error: { code: "invalid_credentials", status: 400 } });
  f.render();
  await f.submit();
  assert.match(text(f.render()), /TPS-PW-CRED-400/);
  const pending = deferred();
  f.signIn = () => pending.promise;
  const submission = f.submit();
  assert.doesNotMatch(text(f.render()), /TPS-PW-CRED-400/);
  pending.resolve(signedIn());
  await submission;
});

test("acceptance: RoleGate feedback codes are visible on unavailable and disabled states", async () => {
  for (const [status, code, expected] of [
    [503, "ACCOUNT_VERIFICATION_UNAVAILABLE", "TPS-AV-VERIFY-503"],
    [403, "ACCOUNT_DISABLED", "TPS-AV-OFF-403"]
  ]) {
    const f = clientFixture("gate");
    f.fetch = async () => json(status, { code });
    f.render();
    await flush();
    const tree = f.render();
    assert.ok(text(find(tree, node => node.props?.["data-testid"] === "account-diagnostic")).includes(expected));
    assert.doesNotMatch(text(tree), /protected-content/);
    assert.equal(f.signIns(), 0);
    assert.equal(f.signOuts(), 0);
  }
});

test("acceptance: student and teacher gates wait for exactly one account GET, not an added request", async () => {
  for (const area of ["student", "teacher"]) {
    const f = clientFixture("gate");
    const pending = deferred();
    let sessionReads = 0;
    f.props.area = area;
    f.getSession = async () => { sessionReads++; return { data: { session: session() }, error: null }; };
    f.fetch = () => pending.promise;
    f.render();
    await flush();
    assert.doesNotMatch(text(f.render()), /protected-content/);
    assert.equal(sessionReads, 1);
    assert.deepEqual(f.requests, [{ url: "/api/account/me", method: "GET" }]);
    pending.resolve(json(200, account(area)));
    await flush();
    assert.match(text(f.render()), /protected-content/);
    assert.equal(f.requests.length, 1);
  }
});

test("acceptance: disabled account with a retained session cannot bounce between login and either area", async () => {
  for (const area of ["student", "teacher"]) {
    const server = serverFixture();
    server.profile.data.role = area;
    server.profile.data.is_active = false;
    const gate = clientFixture("gate");
    gate.props.area = area;
    gate.fetch = () => server.get();
    gate.render();
    await flush();
    for (let i = 0; i < 3; i++) {
      assert.doesNotMatch(text(gate.render()), /protected-content/);
      await flush();
    }
    assert.equal(gate.diagnostics.at(-1).code, "ACCOUNT_DISABLED");
    assert.equal(gate.routes.length, 0);
    assert.equal(gate.requests.length, 1);

    // Model the explicit "返回登录" link, not an automatic redirect.
    const login = clientFixture();
    login.search = `?returnTo=${encodeURIComponent(`/${area}/home`)}`;
    login.getSession = async () => ({ data: { session: session() }, error: null });
    login.fetch = () => server.get();
    login.render();
    await flush();
    for (let i = 0; i < 3; i++) {
      assert.match(text(login.render()), /账号已停用/);
      await flush();
    }
    assert.equal(login.routes.length, 0);
    assert.equal(login.requests.length, 1);
    assert.equal(login.signIns(), 0);
    assert.equal(login.signOuts(), 0);
    assert.equal(gate.signOuts(), 0);
  }
});

test("acceptance: public diagnostic formatter never copies raw names/codes/status strings", () => {
  const failure = credentials.accountFailure("LOGIN_NETWORK_ERROR", "password_sign_in", {
    name: "private-mock-name", code: "private-mock-code", message: "private-mock-response", status: 0
  });
  assert.equal(credentials.accountDiagnosticCode(failure), "TPS-PW-NET-NA");
  assert.equal(credentials.accountDiagnosticCode({ ...failure, status: "private-mock-status" }), "TPS-PW-NET-NA");
});

test("shared client: RoleGate retains verified state on token refresh without another account GET", async () => {
  const f = clientFixture("gate");
  f.render();
  await flush();
  assert.match(text(f.render()), /protected-content/);
  assert.equal(f.subscriptions(), 1);
  for (let i = 0; i < 3; i++) f.emitAuth("TOKEN_REFRESHED", { ...session(), access_token: `mock-updated-${i}` });
  assert.match(text(f.render()), /protected-content/);
  await flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.subscriptions(), 1);
  f.unmount();
  assert.equal(f.subscriptions(), 0);
});

test("shared client: account switch unmounts old account data, then verifies and keys the new identity", async () => {
  const f = clientFixture("gate");
  let active = session();
  f.getSession = async () => ({ data: { session: active }, error: null });
  f.fetch = async () => json(200, { ...account(), userId: active.user.id });
  f.render();
  await flush();
  assert.equal(f.render().props.value.userId, "mock-user");
  active = { ...session(), user: { id: "second-mock-user" } };
  f.emitAuth("SIGNED_IN", active);
  assert.doesNotMatch(text(f.render()), /protected-content/);
  await flush();
  assert.equal(f.render().props.value.userId, "second-mock-user");
  assert.equal(f.subscriptions(), 1);
  assert.equal(f.requests.length, 2);
  f.emitAuth("SIGNED_OUT", null);
  active = null;
  assert.doesNotMatch(text(f.render()), /protected-content/);
  await flush();
  assert.doesNotMatch(text(f.render()), /protected-content/);
  assert.deepEqual(f.routes, [["replace", "/login"]]);
  f.unmount();
  assert.equal(f.subscriptions(), 0);
});
