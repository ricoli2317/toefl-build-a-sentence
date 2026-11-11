const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const notificationHelpers = require("../lib/notifications.ts");

// Run the real handlers with injected auth/PostgREST boundaries. No remote I/O.
function handlers({ role = "admin", authError = null, results = [] } = {}) {
  const calls = [];
  const profile = { userId: "10000000-0000-4000-8000-000000000001", role, error: authError };
  const chain = new Proxy({}, { get: (_, property) => {
    if (property === "then") return (resolve, reject) => Promise.resolve(results.shift() ?? { data: null, error: null }).then(resolve, reject);
    return (...args) => { calls.push([property, ...args]); return chain; };
  } });
  const db = { from: (...args) => { calls.push(["from", ...args]); return chain; },
    rpc: (...args) => { calls.push(["rpc", ...args]); return chain; } };
  const modules = {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/auth": { bearerToken: request => request.headers.get("authorization")?.replace("Bearer ", "") ?? null,
      requireAdmin: async token => !token || role !== "admin" ? { error: "Forbidden" } : profile,
      requireAuthenticatedAccount: async token => !token ? { error: "Unauthorized" } : profile },
    "@/lib/supabase/server": { createAnonSupabase: token => { calls.push(["client", token]); return db; } },
    "./notifications.ts": notificationHelpers
  };
  const compiled = ts.transpileModule(fs.readFileSync("lib/notifications.server.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(name => {
    assert.ok(modules[name], `Unexpected dependency: ${name}`);
    return modules[name];
  }, module, module.exports);
  return { api: module.exports, calls };
}
const id = "20000000-0000-4000-8000-000000000001";
const version = "2026-11-10T10:00:00.123456+00:00";
const draft = { title: "Title", content: "Body", type: "announcement", target_role: "teacher" };
function request(path = "/api/admin/notifications", body, token = "valid") {
  return new Request(`https://local.test${path}`, { method: body ? "PATCH" : "GET",
    headers: token ? { authorization: `Bearer ${token}`, "content-type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}) });
}

test("every admin action rejects non-admins before accessing a notification table", async () => {
  for (const role of ["teacher", "student"]) {
    const { api, calls } = handlers({ role });
    for (const response of [await api.adminNotificationList(request()), await api.adminNotificationCreate(request("/", draft)),
      await api.adminNotificationUpdate(request("/", { action: "publish", updated_at: version }), id)]) {
      assert.equal(response.status, 403);
      assert.match(response.headers.get("cache-control"), /no-store/);
    }
    assert.equal(calls.length, 0);
  }
});

test("disabled/unauthenticated accounts and admins cannot use the recipient inbox", async () => {
  for (const config of [{ role: "admin" }, { role: "student", authError: "disabled" }]) {
    const { api, calls } = handlers(config);
    assert.equal((await api.notificationInbox(request())).status, 403);
    assert.equal((await api.notificationRead(request(), id)).status, 403);
    assert.equal(calls.length, 0);
  }
  const { api } = handlers({ role: "teacher" });
  assert.equal((await api.notificationInbox(request("/api/notifications", undefined, ""))).status, 403);
});

test("summary is a single light RPC and never reads student/teacher business data", async () => {
  const { api, calls } = handlers({ role: "teacher", results: [{ data: 4, error: null }] });
  const response = await api.notificationInbox(request("/api/notifications?view=summary&role=student"));
  assert.deepEqual(await response.json(), { unreadCount: 4 });
  assert.deepEqual(calls, [["client", "valid"], ["rpc", "notification_unread_count"]]);
});

test("recipient pagination uses timestamp/id cursor and fetches only 21 items", async () => {
  const rows = Array.from({ length: 21 }, (_, i) => ({ id: String(i), published_at: version }));
  const { api, calls } = handlers({ role: "student", results: [{ data: rows, error: null }] });
  const response = await api.notificationInbox(request(`/api/notifications?unread=true&before=${encodeURIComponent(version)}&beforeId=${id}`));
  const payload = await response.json();
  assert.equal(payload.notifications.length, 20);
  assert.deepEqual(payload.nextCursor, { before: version, beforeId: "19" });
  assert.deepEqual(calls[1], ["rpc", "notification_inbox", { p_before: version, p_before_id: id, p_unread_only: true, p_limit: 21 }]);
  const invalid = await api.notificationInbox(request("/api/notifications?beforeId=bad"));
  assert.equal(invalid.status, 400);
});

test("draft creation ignores injected publication/creator fields", async () => {
  const { api, calls } = handlers({ results: [{ data: { id }, error: null }] });
  const response = await api.adminNotificationCreate(request("/", { ...draft, status: "published", created_by: "attacker" }));
  assert.equal(response.status, 201);
  assert.deepEqual(calls.find(call => call[0] === "insert"), ["insert", { ...draft, created_by: "10000000-0000-4000-8000-000000000001" }]);
});

test("publish/withdraw use status+version CAS and never accept injected content edits", async () => {
  for (const [action, status, patch] of [["publish", "draft", { status: "published" }], ["withdraw", "published", { status: "withdrawn" }]]) {
    const { api, calls } = handlers({ results: [{ data: { id }, error: null }] });
    const response = await api.adminNotificationUpdate(request("/", { action, updated_at: version, content: "Injected" }), id);
    assert.equal(response.status, 200);
    assert.deepEqual(calls.find(call => call[0] === "update"), ["update", patch]);
    assert.ok(calls.some(call => call[0] === "eq" && call[1] === "status" && call[2] === status));
    assert.ok(calls.some(call => call[0] === "eq" && call[1] === "updated_at" && call[2] === version));
  }
  const { api } = handlers();
  assert.equal((await api.adminNotificationUpdate(request("/", { action: "publish", updated_at: version }), id)).status, 409);
  assert.equal((await api.adminNotificationUpdate(request("/", { action: "publish" }), id)).status, 400);
});

test("reading uses only the authenticated user id, ignores duplicate receipts and returns the original read timestamp", async () => {
  const { api, calls } = handlers({ role: "teacher", results: [
    { data: { id }, error: null }, { data: null, error: null }, { data: { read_at: version }, error: null }
  ] });
  const response = await api.notificationRead(request("/", { user_id: "another-account" }), id);
  assert.deepEqual(await response.json(), { id, read_at: version });
  assert.deepEqual(calls.find(call => call[0] === "upsert"), ["upsert", {
    notification_id: id, user_id: "10000000-0000-4000-8000-000000000001"
  }, { onConflict: "notification_id,user_id", ignoreDuplicates: true }]);
});

test("withdrawn/inaccessible items and failed writes cannot produce a successful read receipt", async () => {
  const gone = handlers({ role: "student", results: [{ data: null, error: null }] });
  assert.equal((await gone.api.notificationRead(request(), id)).status, 404);
  assert.equal(gone.calls.some(call => call[0] === "upsert"), false);
  const failed = handlers({ role: "student", results: [
    { data: { id }, error: null }, { error: { code: "RLS" } }
  ] });
  assert.equal((await failed.api.notificationRead(request(), id)).status, 503);
});
