const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { PGlite } = require("@electric-sql/pglite");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const migrationPath = "supabase/student_practice_entitlements_v1_20261114.sql";
const migration = read(migrationPath);

// Manual preflight/verify/rollback SQL is intentionally kept out of Git. Set
// TPS_MANUAL_SQL_DIR to the local temporary directory to execute those checks.
const MANUAL_SQL_DIR = process.env.TPS_MANUAL_SQL_DIR?.trim() ?? "";
const readManual = (file) => {
  if (!MANUAL_SQL_DIR) return null;
  try {
    return fs.readFileSync(path.join(MANUAL_SQL_DIR, file), "utf8");
  } catch {
    return null;
  }
};
const preflight = readManual("student_practice_entitlements_v1_preflight_20261114.sql");
const verify = readManual("student_practice_entitlements_v1_verify_20261114.sql");
const rollbackTest = readManual("student_practice_entitlements_v1_rollback_test_20261114.sql");
const manualSqlAvailable = Boolean(preflight && verify && rollbackTest);
const manualSqlTest = (name, fn) => test(name, {
  skip: manualSqlAvailable ? false : "Set TPS_MANUAL_SQL_DIR to the local manual SQL directory"
}, fn);

const ADMIN = "10000000-0000-4000-8000-000000000001";
const TEACHER = "10000000-0000-4000-8000-000000000002";
const STUDENT = "10000000-0000-4000-8000-000000000003";
const OTHER_STUDENT = "10000000-0000-4000-8000-000000000004";

const FIXTURE_SQL = `
  create role anon;
  create role authenticated;
  create role service_role bypassrls;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth to authenticated;
  grant execute on function auth.uid() to authenticated;

  create table public.profiles (
    id uuid primary key,
    role text not null,
    is_active boolean not null default true,
    created_at timestamptz not null default now()
  );
  create table public.practice_items (
    item_id text not null,
    task_type text not null,
    primary key (item_id, task_type)
  );
  create table public.reading_logical_items (
    logical_item_id text primary key,
    module text not null
  );
  create table public.writing_assignments (
    assignment_id uuid primary key
  );

  insert into public.profiles(id, role) values
    ('${ADMIN}', 'admin'),
    ('${TEACHER}', 'teacher'),
    ('${STUDENT}', 'student'),
    ('${OTHER_STUDENT}', 'student');
  insert into public.practice_items(item_id, task_type) values
    ('item-bas', 'build_sentence'),
    ('item-email', 'email'),
    ('item-ad', 'academic_discussion');
  insert into public.reading_logical_items(logical_item_id, module) values
    ('reading-ctw-1', 'ctw'),
    ('reading-rdl-1', 'rdl'),
    ('reading-rap-1', 'rap');
`;

const EXPECTED_DEFAULTS = [
  ["build_sentence", 5],
  ["email", 5],
  ["academic_discussion", 5],
  ["ctw", 5],
  ["rdl", 5],
  ["rap", 5],
  ["bas_category", 3],
  ["rap_category", 3]
];

function stripSqlComments(sql) {
  return sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

test("migration SQL is additive, single-transaction and never touches attempts or canonical identities", () => {
  assert.equal((migration.match(/^begin;/gm) ?? []).length, 1);
  assert.equal((migration.match(/^commit;/gm) ?? []).length, 1);
  assert.equal((migration.match(/\$\$/g) ?? []).length % 2, 0);

  for (const table of [
    "practice_entitlement_defaults",
    "student_practice_entitlements",
    "student_practice_unlocks",
    "student_practice_entitlement_events"
  ]) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security`)
    );
  }

  assert.doesNotMatch(
    migration,
    /\b(update|insert\s+into|delete\s+from)\s+public\.(attempts|writing_attempts|reading_attempts|reading_full_set_attempts|writing_assignments|practice_items|practice_item_sources|reading_logical_items)\b/i
  );
  assert.doesNotMatch(migration, /\b(alter|drop|create)\s+table\s+public\.practice_items\b/i);
  assert.doesNotMatch(migration, /\b(alter|drop|create)\s+table\s+public\.reading_logical_items\b/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.student_practice_unlocks/i);
  assert.doesNotMatch(
    migration,
    /create\s+(or\s+replace\s+)?function\s+public\.(?!enforce_)[a-z0-9_]*(unlock|spend|grant)[a-z0-9_]*/i
  );
});

test("schema constraints, identity guards, atomic save and default source are present", () => {
  assert.match(
    migration,
    /primary key \(student_id, entitlement_kind\)/
  );
  assert.match(migration, /remaining integer not null/);
  assert.match(migration, /remaining_nonnegative_check check \(remaining >= 0\)/);
  assert.match(
    migration,
    /primary key \(student_id, task_type, item_id\)/
  );
  assert.match(
    migration,
    /task_type in \(\s*'build_sentence', 'email', 'academic_discussion', 'ctw', 'rdl', 'rap'\s*\)/
  );
  assert.doesNotMatch(
    migration.match(/student_practice_unlocks_task_type_check[\s\S]*?\)\)/)?.[0] ?? "",
    /full_set/
  );
  assert.match(migration, /event_id bigint generated always as identity primary key/);
  assert.match(migration, /operation in \(\s*'admin_set', 'spend', 'unlock', 'grant', 'refund', 'revoke'\s*\)/);
  assert.match(migration, /actor_id uuid references public\.profiles\(id\) on delete restrict/);
  assert.match(migration, /assignment_id uuid references public\.writing_assignments\(assignment_id\) on delete set null/);
  assert.match(migration, /request_id text/);

  assert.match(migration, /\(\s*'build_sentence', 5, 1\)/);
  assert.match(migration, /\(\s*'bas_category', 3, 7\)/);
  assert.match(migration, /coalesce\(entitlements\.remaining, defaults\.default_remaining\)/);
  assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\(p_student_id::text, 0\)\)/);
  assert.match(migration, /on conflict on constraint student_practice_entitlements_pkey do update/);
  assert.match(migration, /role = 'admin' and is_active = true/);
  assert.match(migration, /role = 'student'/);
  assert.match(migration, /INVALID_ENTITLEMENT_VALUE/);
  assert.match(migration, /INVALID_ENTITLEMENT_KIND/);
  assert.match(migration, /INVALID_ENTITLEMENT_PAYLOAD/);
  assert.match(migration, /STUDENT_NOT_FOUND/);
  assert.match(migration, /INVALID_PRACTICE_ITEM_IDENTITY/);
  assert.match(migration, /INVALID_READING_ITEM_IDENTITY/);

  assert.match(
    migration,
    /grant execute on function public\.admin_get_student_practice_entitlements\(uuid\) to authenticated/
  );
  assert.match(
    migration,
    /grant execute on function public\.admin_set_student_practice_entitlements\(uuid, jsonb, text\) to authenticated/
  );
  assert.match(
    migration,
    /grant execute on function public\.student_practice_entitlements_self\(\) to authenticated/
  );
  assert.match(
    migration,
    /revoke all on function public\.student_practice_entitlement_snapshot\(uuid\) from public, anon, authenticated/
  );
  assert.doesNotMatch(migration, /grant\s+(select|insert|update|delete|all)[\s\S]{0,120}\s+to\s+(anon|authenticated)/i);
  assert.doesNotMatch(migration, /create policy/i);
});

manualSqlTest("preflight, verification and rollback files are safe manual companions", () => {
  const preflightCommands = stripSqlComments(preflight);
  const verifyCommands = stripSqlComments(verify);
  for (const commands of [preflightCommands, verifyCommands]) {
    assert.doesNotMatch(
      commands,
      /^\s*(insert|update|delete|create|alter|drop|grant|revoke|begin|commit|rollback)\b/im
    );
  }
  assert.match(preflight, /information_schema\.columns/);
  assert.match(preflight, /to_regprocedure\('auth\.uid\(\)'\)/);
  assert.match(verify, /has_function_privilege/);
  assert.match(verify, /student_practice_entitlement_events/);
  assert.match(rollbackTest, /^begin;/m);
  assert.match(rollbackTest, /^rollback;/m);
  assert.doesNotMatch(rollbackTest, /^commit;/m);
  assert.match(rollbackTest, /existing Admin \/ Student \/ Teacher rows; it creates none/);
});

test("PGlite: defaults, Admin save 0/larger, audit pairing, repeat saves and atomic rollback", async (t) => {
  const db = new PGlite();

  async function resetToPostgres() {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }

  async function actAs(id) {
    await resetToPostgres();
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    await db.exec("set role authenticated");
  }

  async function adminSet(values, reason = "manual_test") {
    const result = await db.query(
      `select jsonb_object_agg(entitlement_kind, remaining) as snapshot
       from public.admin_set_student_practice_entitlements($1, $2::jsonb, $3)`,
      [STUDENT, JSON.stringify(values), reason]
    );
    return result.rows[0].snapshot;
  }

  async function selfRead() {
    return (await db.query("select * from public.student_practice_entitlements_self()")).rows;
  }

  async function adminRead() {
    return (await db.query(
      "select * from public.admin_get_student_practice_entitlements($1)",
      [STUDENT]
    )).rows;
  }

  try {
    await db.exec(FIXTURE_SQL);
    await db.exec(migration);
    await resetToPostgres();

    await t.test("all eight defaults are exact and no entitlement rows are pre-created", async () => {
      const defaults = (await db.query(
        "select entitlement_kind, default_remaining, sort_order from public.practice_entitlement_defaults order by sort_order"
      )).rows;
      assert.deepEqual(
        defaults.map((row) => [row.entitlement_kind, row.default_remaining]),
        EXPECTED_DEFAULTS
      );
      assert.equal(defaults.length, 8);
      assert.equal(
        (await db.query("select count(*)::int n from public.student_practice_entitlements")).rows[0].n,
        0
      );
      assert.equal(
        (await db.query("select count(*)::int n from public.student_practice_unlocks")).rows[0].n,
        0
      );
      assert.equal(
        (await db.query("select count(*)::int n from public.student_practice_entitlement_events")).rows[0].n,
        0
      );
    });

    await t.test("a missing row reads the default and an explicit 0 persists", async () => {
      await actAs(STUDENT);
      const own = await selfRead();
      assert.equal(own.length, 8);
      assert.equal(own.find((row) => row.entitlement_kind === "build_sentence").remaining, 5);
      assert.equal(own.find((row) => row.entitlement_kind === "bas_category").remaining, 3);
      assert.equal(own.every((row) => row.is_explicit === false), true);

      await actAs(ADMIN);
      const before = await adminRead();
      assert.equal(before.length, 8);
      assert.equal(before.find((row) => row.entitlement_kind === "build_sentence").remaining, 5);

      const snapshot = await adminSet({ build_sentence: 0, email: 8 });
      assert.equal(snapshot.build_sentence, 0);
      assert.equal(snapshot.email, 8);
      assert.equal(snapshot.ctw, 5);

      await resetToPostgres();
      const rows = (await db.query(
        "select entitlement_kind, remaining, updated_by from public.student_practice_entitlements where student_id = $1 order by entitlement_kind",
        [STUDENT]
      )).rows;
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((row) => [row.entitlement_kind, row.remaining]),
        [["build_sentence", 0], ["email", 8]]
      );
      assert.equal(rows.every((row) => row.updated_by === ADMIN), true);

      const events = (await db.query(
        "select entitlement_kind, operation, reason, previous_remaining, new_remaining, actor_id from public.student_practice_entitlement_events where student_id = $1 and operation = 'admin_set'",
        [STUDENT]
      )).rows;
      assert.equal(events.length, 2);
      const byKind = new Map(events.map((row) => [row.entitlement_kind, row]));
      assert.deepEqual(byKind.get("build_sentence"), {
        entitlement_kind: "build_sentence",
        operation: "admin_set",
        reason: "manual_test",
        previous_remaining: 5,
        new_remaining: 0,
        actor_id: ADMIN
      });
      assert.deepEqual(byKind.get("email"), {
        entitlement_kind: "email",
        operation: "admin_set",
        reason: "manual_test",
        previous_remaining: 5,
        new_remaining: 8,
        actor_id: ADMIN
      });
    });

    await t.test("repeat saves never duplicate rows or audit entries", async () => {
      await actAs(ADMIN);
      await adminSet({ build_sentence: 0, email: 8 });
      await adminSet({ build_sentence: 0, email: 8 });
      await resetToPostgres();
      assert.equal(
        (await db.query(
          "select count(*)::int n from public.student_practice_entitlements where student_id = $1",
          [STUDENT]
        )).rows[0].n,
        2
      );
      assert.equal(
        (await db.query(
          "select count(*)::int n from public.student_practice_entitlement_events where student_id = $1 and operation = 'admin_set'",
          [STUDENT]
        )).rows[0].n,
        2
      );
    });

    await t.test("a value greater than the default and the maximum integer are accepted", async () => {
      await actAs(ADMIN);
      const snapshot = await adminSet({ ctw: 9, rdl: 2147483647 });
      assert.equal(snapshot.ctw, 9);
      assert.equal(snapshot.rdl, 2147483647);
    });

    await t.test("invalid input is rejected before any row or event is written", async () => {
      await resetToPostgres();
      const before = (await db.query(
        "select count(*)::int n from public.student_practice_entitlement_events where student_id = $1",
        [STUDENT]
      )).rows[0].n;

      await actAs(ADMIN);
      for (const [values, pattern] of [
        [{ build_sentence: -1 }, /INVALID_ENTITLEMENT_VALUE/],
        [{ build_sentence: 1.5 }, /INVALID_ENTITLEMENT_VALUE/],
        [{ build_sentence: "5" }, /INVALID_ENTITLEMENT_VALUE/],
        [{ build_sentence: true }, /INVALID_ENTITLEMENT_VALUE/],
        [{ build_sentence: null }, /INVALID_ENTITLEMENT_VALUE/],
        [{ build_sentence: 2147483648 }, /INVALID_ENTITLEMENT_VALUE/],
        [{ full_set: 1 }, /INVALID_ENTITLEMENT_KIND/],
        [{ build_sentence: 1, unknown: 2 }, /INVALID_ENTITLEMENT_KIND/],
        [{}, /INVALID_ENTITLEMENT_PAYLOAD/]
      ]) {
        await assert.rejects(adminSet(values), pattern, JSON.stringify(values));
      }

      await resetToPostgres();
      assert.equal(
        (await db.query(
          "select count(*)::int n from public.student_practice_entitlement_events where student_id = $1",
          [STUDENT]
        )).rows[0].n,
        before
      );
    });

    await t.test("Student and Teacher cannot call Admin RPCs or read another student's values", async () => {
      await actAs(TEACHER);
      await assert.rejects(
        db.query("select * from public.admin_get_student_practice_entitlements($1)", [STUDENT]),
        /ADMIN_REQUIRED/
      );
      await assert.rejects(
        db.query(
          "select * from public.admin_set_student_practice_entitlements($1, '{\"build_sentence\": 1}'::jsonb, 'manual')",
          [STUDENT]
        ),
        /ADMIN_REQUIRED/
      );
      await assert.rejects(
        db.query("select * from public.student_practice_entitlements_self()"),
        /STUDENT_REQUIRED/
      );

      await actAs(OTHER_STUDENT);
      const own = await selfRead();
      assert.equal(own.length, 8);
      assert.equal(own.find((row) => row.entitlement_kind === "build_sentence").remaining, 5);
      assert.equal(
        own.find((row) => row.entitlement_kind === "email").remaining,
        5,
        "the self RPC returns the caller's values, not STUDENT's explicit values"
      );
      await assert.rejects(
        db.query("select * from public.admin_get_student_practice_entitlements($1)", [STUDENT]),
        /ADMIN_REQUIRED/
      );
      await assert.rejects(
        db.query(
          "select * from public.admin_set_student_practice_entitlements($1, '{\"build_sentence\": 1}'::jsonb, 'manual')",
          [STUDENT]
        ),
        /ADMIN_REQUIRED/
      );
    });

    await t.test("Student direct table writes/reads are denied", async () => {
      await actAs(STUDENT);
      await assert.rejects(
        db.query(
          "insert into public.student_practice_entitlements(student_id, entitlement_kind, remaining) values ($1, 'ctw', 1)",
          [STUDENT]
        ),
        /permission denied/
      );
      await assert.rejects(
        db.query("update public.student_practice_entitlements set remaining = 1 where student_id = $1", [STUDENT]),
        /permission denied/
      );
      await assert.rejects(
        db.query("delete from public.student_practice_unlocks"),
        /permission denied/
      );
      await assert.rejects(
        db.query("select * from public.student_practice_entitlements"),
        /permission denied/
      );
      await assert.rejects(
        db.query("select * from public.student_practice_entitlement_events"),
        /permission denied/
      );
      await assert.rejects(
        db.query("select * from public.student_practice_unlocks"),
        /permission denied/
      );
    });

    await t.test("deleting the explicit row returns to the default, and a new 0 is still explicit", async () => {
      await resetToPostgres();
      await db.query(
        "delete from public.student_practice_entitlements where student_id = $1 and entitlement_kind = 'email'",
        [STUDENT]
      );
      await actAs(STUDENT);
      const own = await selfRead();
      assert.equal(own.find((row) => row.entitlement_kind === "email").remaining, 5);
      assert.equal(own.find((row) => row.entitlement_kind === "email").is_explicit, false);

      await actAs(ADMIN);
      const snapshot = await adminSet({ email: 0 });
      assert.equal(snapshot.email, 0);
      await actAs(STUDENT);
      const after = await selfRead();
      assert.equal(after.find((row) => row.entitlement_kind === "email").remaining, 0);
      assert.equal(after.find((row) => row.entitlement_kind === "email").is_explicit, true);
    });

    await t.test("audit failure rolls back the entitlement update in the same transaction", async () => {
      await resetToPostgres();
      const before = (await db.query(
        "select remaining from public.student_practice_entitlements where student_id = $1 and entitlement_kind = 'build_sentence'",
        [STUDENT]
      )).rows[0].remaining;
      const eventCountBefore = (await db.query(
        "select count(*)::int n from public.student_practice_entitlement_events where student_id = $1",
        [STUDENT]
      )).rows[0].n;

      await db.exec(`
        create function public.force_practice_entitlement_audit_failure()
        returns trigger language plpgsql as $$
        begin
          raise exception 'FORCED_AUDIT_FAILURE';
        end;
        $$;
        create trigger force_practice_entitlement_audit_failure
        before insert on public.student_practice_entitlement_events
        for each row execute function public.force_practice_entitlement_audit_failure();
      `);

      await actAs(ADMIN);
      await assert.rejects(
        adminSet({ build_sentence: before === 4 ? 3 : 4 }),
        /FORCED_AUDIT_FAILURE/
      );

      await resetToPostgres();
      assert.equal(
        (await db.query(
          "select remaining from public.student_practice_entitlements where student_id = $1 and entitlement_kind = 'build_sentence'",
          [STUDENT]
        )).rows[0].remaining,
        before
      );
      assert.equal(
        (await db.query(
          "select count(*)::int n from public.student_practice_entitlement_events where student_id = $1",
          [STUDENT]
        )).rows[0].n,
        eventCountBefore
      );

      await db.exec(`
        drop trigger force_practice_entitlement_audit_failure on public.student_practice_entitlement_events;
        drop function public.force_practice_entitlement_audit_failure();
      `);
    });

    await t.test("unlock guards enforce Student identity and canonical item identity", async () => {
      await resetToPostgres();
      await db.query(
        "insert into public.student_practice_unlocks(student_id, task_type, item_id, source) values ($1, 'build_sentence', 'item-bas', 'manual_test')",
        [STUDENT]
      );
      await db.query(
        "insert into public.student_practice_unlocks(student_id, task_type, item_id, source) values ($1, 'rdl', 'reading-rdl-1', 'manual_test')",
        [STUDENT]
      );
      assert.equal(
        (await db.query("select count(*)::int n from public.student_practice_unlocks")).rows[0].n,
        2
      );
      await assert.rejects(
        db.query(
          "insert into public.student_practice_unlocks(student_id, task_type, item_id, source) values ($1, 'build_sentence', 'missing-item', 'manual_test')",
          [STUDENT]
        ),
        /INVALID_PRACTICE_ITEM_IDENTITY/
      );
      await assert.rejects(
        db.query(
          "insert into public.student_practice_unlocks(student_id, task_type, item_id, source) values ($1, 'rap', 'missing-item', 'manual_test')",
          [STUDENT]
        ),
        /INVALID_READING_ITEM_IDENTITY/
      );
      await assert.rejects(
        db.query(
          "insert into public.student_practice_unlocks(student_id, task_type, item_id, source) values ($1, 'build_sentence', 'item-bas', 'manual_test')",
          [TEACHER]
        ),
        /STUDENT_NOT_FOUND/
      );
      await assert.rejects(
        db.query(
          "insert into public.student_practice_unlocks(student_id, task_type, item_id, source) values ($1, 'build_sentence', 'item-bas', 'manual_test')",
          [STUDENT]
        ),
        /duplicate key value|unique constraint/
      );
    });

    await t.test("database constraints reject negative/duplicate/teacher entitlement rows and malformed admin events", async () => {
      await resetToPostgres();
      await assert.rejects(
        db.query(
          "insert into public.student_practice_entitlements(student_id, entitlement_kind, remaining) values ($1, 'build_sentence', 0)",
          [STUDENT]
        ),
        /duplicate key value|unique constraint/
      );
      await assert.rejects(
        db.query(
          "insert into public.student_practice_entitlements(student_id, entitlement_kind, remaining) values ($1, 'academic_discussion', -1)",
          [STUDENT]
        ),
        /remaining_nonnegative|violates check constraint/
      );
      await assert.rejects(
        db.query(
          "insert into public.student_practice_entitlements(student_id, entitlement_kind, remaining) values ($1, 'academic_discussion', 1)",
          [TEACHER]
        ),
        /STUDENT_NOT_FOUND/
      );
      await assert.rejects(
        db.query(
          "insert into public.student_practice_entitlement_events(student_id, entitlement_kind, operation, previous_remaining, new_remaining) values ($1, 'academic_discussion', 'admin_set', 1, 2)",
          [STUDENT]
        ),
        /admin_set_shape|violates check constraint/
      );
    });
  } finally {
    await db.close();
  }
});

manualSqlTest("manual rollback test executes and leaves no entitlement, unlock or audit writes", async () => {
  const db = new PGlite();
  try {
    await db.exec(FIXTURE_SQL);
    await db.exec(migration);
    await db.exec(rollbackTest);

    const counts = (await db.query(`
      select
        (select count(*)::int from public.student_practice_entitlements) as entitlements,
        (select count(*)::int from public.student_practice_entitlement_events) as events,
        (select count(*)::int from public.student_practice_unlocks) as unlocks
    `)).rows[0];
    assert.deepEqual(counts, { entitlements: 0, events: 0, unlocks: 0 });
  } finally {
    await db.close();
  }
});

manualSqlTest("manual preflight and verify SQL execute successfully after migration", async () => {
  const db = new PGlite();
  try {
    await db.exec(FIXTURE_SQL);
    await db.exec(preflight);
    await db.exec(migration);
    await db.exec(verify);
  } finally {
    await db.close();
  }
});

test("migration is re-runnable without duplicating defaults or losing explicit rows", async () => {
  const db = new PGlite();
  try {
    await db.exec(FIXTURE_SQL);
    await db.exec(migration);
    await db.query(
      "insert into public.student_practice_entitlements(student_id, entitlement_kind, remaining) values ($1, 'build_sentence', 0)",
      [STUDENT]
    );
    await db.exec(migration);

    assert.equal(
      (await db.query("select count(*)::int n from public.practice_entitlement_defaults")).rows[0].n,
      8
    );
    const explicit = (await db.query(
      "select remaining from public.student_practice_entitlements where student_id = $1 and entitlement_kind = 'build_sentence'",
      [STUDENT]
    )).rows;
    assert.equal(explicit.length, 1);
    assert.equal(explicit[0].remaining, 0);
  } finally {
    await db.close();
  }
});
