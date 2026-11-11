const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const notificationHelpers = require("../lib/notifications.ts");

// Run the real handlers with injected auth/PostgREST boundaries. No remote I/O.
function handlers({ role = "admin", authError = null, results = [], imageError = null } = {}) {
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
    "./notifications.ts": notificationHelpers,
    "./notificationDocument.ts": require('../lib/notificationDocument.ts'),
    "./notificationImages.server.ts": { assertNotificationImagesPublishable: async document => { calls.push(['check-images', document]); if (imageError) throw Error(imageError); } }
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
    for (const response of [await api.adminNotificationList(request()), await api.adminNotificationCreate(request("/", draft)), await api.adminNotificationDelete(request('/',{updated_at:version}),id),
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
  assert.deepEqual(calls[1], ["rpc", "notification_inbox_titles", { p_before: version, p_before_id: id, p_unread_only: true, p_limit: 21 }]);
  const invalid = await api.notificationInbox(request("/api/notifications?beforeId=bad"));
  assert.equal(invalid.status, 400);
});

test("draft creation ignores injected publication/creator fields", async () => {
  const { api, calls } = handlers({ results: [{ data: id, error: null }] });
  const response = await api.adminNotificationCreate(request("/", { ...draft, status: "published", created_by: "attacker" }));
  assert.equal(response.status, 201);
  assert.deepEqual(calls.find(call => call[0] === "rpc"), ["rpc", "admin_create_system_notification", {
    p_title: draft.title, p_content: draft.content, p_type: draft.type, p_target_role: draft.target_role, p_document:null, p_publish:false
  }]);
});

test("publish/withdraw use status+version CAS and never accept injected content edits", async () => {
  for (const [action, status, patch] of [["publish", "draft", { status: "published" }], ["withdraw", "published", { status: "withdrawn" }]]) {
    const { api, calls } = handlers({ results: [...(action === 'publish' ? [{data:{content_document:null},error:null}] : []), { data: { id }, error: null }] });
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

test('direct publish is one atomic RPC; invalid/expired images prevent any create or publish write',async()=>{
  const ready=handlers({results:[{data:id,error:null}]});
  assert.equal((await ready.api.adminNotificationCreate(request('/',{...draft,action:'publish'}))).status,201);
  assert.equal(ready.calls.filter(c=>c[0]==='rpc').length,1);
  assert.equal(ready.calls.find(c=>c[0]==='rpc')[2].p_publish,true);
  const expired=handlers({imageError:'草稿图片已过期，请重新上传后发布。'});
  assert.equal((await expired.api.adminNotificationCreate(request('/',{...draft,action:'publish'}))).status,409);
  assert.equal(expired.calls.some(c=>c[0]==='rpc'),false);
});

test('Admin list excludes tombstones; delete changes only admin_deleted_at, never status/content/reads',async()=>{
  const h=handlers({results:[{data:[],error:null},{data:{id},error:null}]});
  assert.equal((await h.api.adminNotificationList(request())).status,200);
  assert.ok(h.calls.some(c=>c[0]==='is'&&c[1]==='admin_deleted_at'&&c[2]===null));
  assert.equal((await h.api.adminNotificationDelete(request('/',{updated_at:version}),id)).status,200);
  const patch=h.calls.find(c=>c[0]==='update')[1];
  assert.deepEqual(Object.keys(patch),['admin_deleted_at']);
  assert.equal(h.calls.some(c=>c[0]==='delete'||c.includes('user_notification_reads')),false);
});

test('detail loads through recipient RLS, preserves literal legacy content and own receipt',async()=>{
  const h=handlers({role:'teacher',results:[{data:{id,content:'<script>literal</script>',content_document:null},error:null},{data:{read_at:version},error:null}]});
  const response=await h.api.notificationDetail(request('/'),id);
  const item=(await response.json()).notification;
  assert.equal(item.content,'<script>literal</script>');assert.equal(item.content_document,null);assert.equal(item.read_at,version);
  assert.ok(h.calls.some(c=>c[0]==='eq'&&c[1]==='user_id'));
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
