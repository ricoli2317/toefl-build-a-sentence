const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");
const { NotificationCache } = require("../lib/notificationCache.ts");
const { validateNotificationDraft, isNotificationSafePage } = require("../lib/notifications.ts");

const sql = fs.readFileSync("supabase/system_notifications_20261110.sql", "utf8");
const ids = {
  admin: "10000000-0000-4000-8000-000000000001",
  teacher: "10000000-0000-4000-8000-000000000002",
  student: "10000000-0000-4000-8000-000000000003",
  other: "10000000-0000-4000-8000-000000000004",
  disabled: "10000000-0000-4000-8000-000000000005"
};

test("draft validation rejects invalid roles, types, blanks, oversized text and prototype keys", () => {
  const valid = { title: " Test ", content: " Text ", type: "announcement", target_role: "all" };
  assert.equal(validateNotificationDraft(valid).title, "Test");
  for (const value of [null, [], { ...valid, title: " " }, { ...valid, content: " " },
    { ...valid, title: "x".repeat(161) }, { ...valid, content: "x".repeat(20001) },
    { ...valid, type: "toString" }, { ...valid, type: "urgent" }, { ...valid, target_role: "admin" }]) {
    assert.equal(validateNotificationDraft(value), null);
  }
});

test("only known non-practice entry pages permit notifications, regardless of role/area switch", () => {
  for (const route of ["/student", "/student/sets", "/teacher/dashboard", "/student/reading/full-sets", "/student/write-email"]) {
    assert.equal(isNotificationSafePage(route), true, route);
  }
  for (const route of ["/student/practice/set", "/student/reading/practice/item", "/student/write-email/practice/id",
    "/student/academic-discussion/practice/id", "/student/reading/full-sets/set/attempt/id",
    "/student/write-email/submission/id", "/student/assignments/id", "/student/wrong-questions/today/practice",
    "/student/question-category-practice/sessions/id/questions/1", "/student/ctw-vocabulary/session/id",
    "/student/grammar-practice/practice", "/student/wordbook/review", "/teacher/writing/reviews/id", "/unknown-new-route"]) {
    assert.equal(isNotificationSafePage(route), false, route);
  }
});

test("cache coalesces concurrent checks and navigation/remount checks within TTL", async () => {
  let calls = 0;
  let now = 100000;
  const cache = new NotificationCache(async () => { calls++; return 3; }, () => now);
  await Promise.all([cache.refresh(), cache.refresh(), cache.refresh()]);
  assert.equal(calls, 1);
  await cache.refresh();
  assert.equal(calls, 1);
  now += 60001;
  await cache.refresh();
  assert.equal(calls, 2);
});

test("an old badge/list response cannot resurrect a just-confirmed notification", async () => {
  const pending = [];
  const cache = new NotificationCache(() => new Promise(resolve => pending.push(resolve)));
  const refresh = cache.refresh();
  cache.confirm("notice", "2026-11-10T10:00:00Z", true);
  pending.shift()(2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cache.unreadCount, null, "stale result was discarded");
  pending.shift()(1);
  await refresh;
  assert.equal(cache.unreadCount, 1);
  cache.confirm("notice", "2026-11-10T10:01:00Z", true);
  assert.equal(cache.unreadCount, 1, "duplicate tab receipt cannot decrement twice");
  assert.equal(cache.overlay([{ id: "notice", read_at: null }])[0].read_at, "2026-11-10T10:00:00Z");
});

test("logout discards identity-scoped receipts and ignores old in-flight work", async () => {
  let resolve;
  const cache = new NotificationCache(() => new Promise(done => { resolve = done; }));
  const pending = cache.refresh();
  cache.confirm("id", "date", true);
  cache.autoOffered = true;
  cache.clear();
  resolve(9);
  await pending;
  assert.equal(cache.unreadCount, null);
  assert.equal(cache.autoOffered, false);
  assert.equal(cache.overlay([{ id: "id", read_at: null }])[0].read_at, null);
});

test("migration touches no existing business structures and grants no read-record rewrite", () => {
  assert.doesNotMatch(sql, /(?:alter table|create trigger[\s\S]*? on) public\.(?:profiles|writing_attempts|reading_attempts)\b/i);
  assert.doesNotMatch(sql, /security definer/i);
  assert.match(sql, /primary key \(notification_id, user_id\)/);
  assert.match(sql, /grant select, insert on public\.user_notification_reads to authenticated/);
  assert.doesNotMatch(sql, /grant[^;]*(?:update|delete)[^;]*user_notification_reads/i);
});

// OFFLINE ONLY: isolated in-memory Postgres. No Supabase URL/key/network client.
test("manual migration executes in isolated Postgres: roles, RLS, lifecycle, receipts, pagination", async t => {
  const db = new PGlite();
  const notices = {};
  const actor = async (name, role = "authenticated") => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [ids[name] ?? ""]);
    await db.exec(`set role ${role}`);
  };
  const inbox = () => db.query("select * from public.notification_inbox()");
  const count = async () => Number((await db.query("select public.notification_unread_count() as n")).rows[0].n);
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
      grant usage on schema auth to anon, authenticated;
      grant execute on function auth.uid() to anon, authenticated;
      create table public.profiles(id uuid primary key, role text not null, is_active boolean not null default true);
      alter table public.profiles enable row level security;
      create policy profiles_self on public.profiles for select to authenticated using (id = (select auth.uid()));
      grant select on public.profiles to authenticated;
    `);
    for (const [name, id] of Object.entries(ids)) {
      await db.query("insert into public.profiles values ($1, $2, $3)", [id,
        name === "admin" ? "admin" : name === "student" ? "student" : "teacher", name !== "disabled"]);
    }
    await db.exec(sql);
    await actor("admin");
    for (const target of ["all", "teacher", "student"]) {
      const created = await db.query(`insert into public.system_notifications(title, content, target_role)
        values ($1, 'Original body', $1) returning id`, [target]);
      notices[target] = created.rows[0].id;
      await db.query("update public.system_notifications set status='published' where id=$1", [notices[target]]);
    }
    notices.draft = (await db.query("insert into public.system_notifications(title,content) values ('draft','draft') returning id")).rows[0].id;

    await t.test("all/teacher/student targeting follows the actual profiles role", async () => {
      await actor("teacher");
      assert.deepEqual(new Set((await inbox()).rows.map(r => r.target_role)), new Set(["all", "teacher"]));
      assert.equal(await count(), 2);
      await actor("student");
      assert.deepEqual(new Set((await inbox()).rows.map(r => r.target_role)), new Set(["all", "student"]));
      assert.equal(await count(), 2);
      await actor("disabled");
      assert.equal((await inbox()).rows.length, 0);
      await actor("", "anon");
      await assert.rejects(inbox(), /permission denied/);
    });

    await t.test("recipients cannot create/publish or confirm wrong-role/draft/other-user notices", async () => {
      await actor("student");
      await assert.rejects(db.query("insert into public.system_notifications(title,content) values ('hack','hack')"), /row-level security/);
      assert.equal((await db.query("update public.system_notifications set status='published' where id=$1 returning id", [notices.draft])).rows.length, 0);
      for (const id of [notices.teacher, notices.draft]) {
        await assert.rejects(db.query("insert into public.user_notification_reads(notification_id) values ($1)", [id]), /row-level security/);
      }
      await assert.rejects(db.query("insert into public.user_notification_reads(notification_id,user_id) values ($1,$2)", [notices.all, ids.teacher]), /row-level security/);
    });

    await t.test("each user confirms independently; duplicate confirmation is idempotent across devices", async () => {
      await actor("student");
      const readSql = "insert into public.user_notification_reads(notification_id) values ($1) on conflict (notification_id,user_id) do nothing";
      await db.query(readSql, [notices.all]);
      const first = (await db.query("select read_at from public.user_notification_reads where notification_id=$1", [notices.all])).rows[0].read_at;
      await actor("student"); // Fresh request/device, same authenticated account.
      await db.query(readSql, [notices.all]);
      assert.equal((await db.query("select count(*)::int n from public.user_notification_reads")).rows[0].n, 1);
      assert.deepEqual((await db.query("select read_at from public.user_notification_reads where notification_id=$1", [notices.all])).rows[0].read_at, first);
      assert.equal(await count(), 1);
      assert.deepEqual((await inbox()).rows.find(r => r.id === notices.all).read_at, first, "read item remains viewable");
      assert.equal((await db.query("select * from notification_inbox(null,null,true)")).rows.length, 1);
      await actor("teacher");
      assert.equal(await count(), 2, "student read must not affect teacher");
      assert.equal((await db.query("select * from public.user_notification_reads")).rows.length, 0);
      await db.query(readSql, [notices.all]);
      assert.equal(await count(), 1);
      await assert.rejects(db.query("update public.user_notification_reads set read_at=now()"), /permission denied/);
      await assert.rejects(db.query("delete from public.user_notification_reads"), /permission denied/);
    });

    await t.test("published payload is immutable, withdrawal hides it and cannot reset read history", async () => {
      await actor("admin");
      await assert.rejects(db.query("update public.system_notifications set content='changed' where id=$1", [notices.all]), /NOTIFICATION_PUBLISHED_IMMUTABLE/);
      await assert.rejects(db.query("update public.system_notifications set target_role='student' where id=$1", [notices.teacher]), /NOTIFICATION_PUBLISHED_IMMUTABLE/);
      await db.query("update public.system_notifications set status='withdrawn' where id=$1", [notices.all]);
      await assert.rejects(db.query("update public.system_notifications set status='draft' where id=$1", [notices.all]), /NOTIFICATION_INVALID_TRANSITION/);
      await actor("student");
      assert.equal((await inbox()).rows.some(r => r.id === notices.all), false);
      await assert.rejects(db.query("insert into public.user_notification_reads(notification_id) values ($1) on conflict do nothing", [notices.all]), /row-level security/);
      assert.equal((await db.query("select * from public.user_notification_reads")).rows.length, 1, "historical receipt retained");
    });

    await t.test("many notices can be paged and individually confirmed without missing equal timestamps", async () => {
      await actor("admin");
      for (let i = 0; i < 25; i++) {
        const row = (await db.query("insert into public.system_notifications(title,content) values ($1,'body') returning id", [`Batch ${i}`])).rows[0];
        await db.query("update public.system_notifications set status='published' where id=$1", [row.id]);
      }
      // Test the cursor tie-breaker without changing any production objects.
      await db.exec("reset role; alter table public.system_notifications disable trigger system_notifications_lifecycle");
      await db.exec("update public.system_notifications set published_at='2026-01-01' where title like 'Batch %'");
      await db.exec("alter table public.system_notifications enable trigger system_notifications_lifecycle");
      await actor("student");
      let cursor = [null, null];
      const seen = [];
      for (;;) {
        const rows = (await db.query("select * from notification_inbox($1,$2,true,7)", cursor)).rows;
        if (!rows.length) break;
        for (const row of rows) {
          assert.equal(seen.includes(row.id), false);
          seen.push(row.id);
          await db.query("insert into user_notification_reads(notification_id) values ($1)", [row.id]);
        }
        cursor = [rows.at(-1).published_at, rows.at(-1).id];
      }
      assert.equal(seen.length, 26);
      assert.equal(await count(), 0);
      assert.equal((await inbox()).rows.length, 20, "read list still paginates");
    });
  } finally { await db.close(); }
});
