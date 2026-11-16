const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { PGlite } = require("@electric-sql/pglite");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const PHASE1 = read("supabase/student_practice_entitlements_v1_20261114.sql");
const PHASE2 = read("supabase/student_practice_entitlements_v2_20261114.sql");
const PHASE3 = read("supabase/student_practice_entitlements_v3_20261114.sql");

const MANUAL_SQL_DIR = process.env.TPS_MANUAL_SQL_DIR?.trim() ?? "";
const readManual = (file) => {
  if (!MANUAL_SQL_DIR) return null;
  try {
    return fs.readFileSync(path.join(MANUAL_SQL_DIR, file), "utf8");
  } catch {
    return null;
  }
};
const V3_PREFLIGHT = readManual("preflight_phase3.sql");
const V3_VERIFY = readManual("verify_phase3.sql");
const V3_BACKFILL_DRY = readManual("student_practice_entitlements_v3_backfill_dry_run_20261114.sql");
const V3_BACKFILL_APPLY = readManual("student_practice_entitlements_v3_backfill_apply_20261114.sql");
const V3_BACKFILL_VERIFY = readManual("student_practice_entitlements_v3_backfill_verify_20261114.sql");
const phase3SqlAvailable = Boolean(V3_PREFLIGHT && V3_VERIFY);
const v3BackfillAvailable = Boolean(V3_BACKFILL_DRY && V3_BACKFILL_APPLY && V3_BACKFILL_VERIFY);
const phase3SqlTest = (name, fn) => test(name, {
  skip: phase3SqlAvailable ? false : "Set TPS_MANUAL_SQL_DIR to the local manual SQL directory"
}, fn);
const v3BackfillTest = (name, fn) => test(name, {
  skip: v3BackfillAvailable ? false : "Set TPS_MANUAL_SQL_DIR to the local manual SQL directory"
}, fn);

const ADMIN = "10000000-0000-4000-8000-000000000001";
const TEACHER = "10000000-0000-4000-8000-000000000002";
const STUDENT = "10000000-0000-4000-8000-000000000003";
const STUDENT2 = "10000000-0000-4000-8000-000000000004";
const STUDENT3 = "10000000-0000-4000-8000-000000000005";

const FS_A = "20260101A";
const FS_B = "20260101B";
const CTW = "reading-ctw-aaaaaaaaaaaaaaaaaaaaaaaa";
const RDL = "reading-rdl-bbbbbbbbbbbbbbbbbbbbbbbb";
const RAP = "reading-rap-cccccccccccccccccccccccc";
const RAP2 = "reading-rap-dddddddddddddddddddddddd";
const CTW_OTHER = "reading-ctw-eeeeeeeeeeeeeeeeeeeeeeee";

const FULL_ASSIGNMENT = "90000000-0000-4000-8000-000000000011";
const FULL_WITHDRAWN = "90000000-0000-4000-8000-000000000012";
const FULL_OTHER = "90000000-0000-4000-8000-000000000013";

const FIXTURE = `
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
    item_id uuid primary key,
    task_type text not null,
    is_active boolean not null default true
  );
  create table public.practice_item_sources (
    source_id uuid primary key,
    item_id uuid not null references public.practice_items(item_id),
    task_type text not null,
    source_set_id text,
    source_question_id text,
    is_canonical boolean not null default false
  );
  create unique index practice_item_sources_set_identity_uidx
    on public.practice_item_sources(task_type, source_set_id)
    where source_set_id is not null;
  create unique index practice_item_sources_question_identity_uidx
    on public.practice_item_sources(task_type, source_question_id)
    where source_question_id is not null;

  create table public.reading_logical_items (
    logical_item_id text primary key,
    module text not null,
    scored_item_count integer not null default 2
  );
  create table public.reading_attempts (
    attempt_id uuid primary key default gen_random_uuid(),
    student_id uuid not null,
    logical_item_id text not null,
    task_type text not null,
    status text not null default 'draft',
    elapsed_seconds integer not null default 0,
    started_at timestamptz not null default now(),
    submitted_at timestamptz,
    total_points integer not null default 0,
    correct_points integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create unique index reading_attempts_one_draft_per_item
    on public.reading_attempts(student_id, logical_item_id, task_type)
    where status = 'draft';

  create table public.questions (
    question_id text primary key,
    set_id text
  );
  create table public.attempts (
    attempt_id uuid primary key default gen_random_uuid(),
    student_id uuid not null,
    set_id text not null,
    set_title text not null default '',
    correct_count integer not null default 0,
    total_questions integer not null default 0,
    time_spent_seconds integer not null default 0,
    submitted_at timestamptz,
    created_at timestamptz not null default now()
  );
  create table public.attempt_answers (
    attempt_answer_id uuid primary key default gen_random_uuid(),
    attempt_id uuid not null,
    question_id text not null,
    student_id uuid not null,
    set_id text not null,
    question_order integer not null default 0,
    prompt text not null default '',
    submitted_order_text text not null default '',
    correct_order_text text not null default '',
    is_correct boolean not null default false
  );
  create table public.writing_assignments (
    assignment_id uuid primary key default gen_random_uuid(),
    task_type text not null,
    question_source text not null,
    question_id text,
    question_snapshot jsonb not null default '{}'::jsonb,
    status text not null default 'active',
    deleted_at timestamptz
  );
  create table public.writing_assignment_students (
    assignment_id uuid not null,
    student_id uuid not null,
    primary key (assignment_id, student_id)
  );
  create table public.writing_attempts (
    attempt_id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    task_type text not null,
    question_id text not null,
    assignment_id uuid,
    attempt_kind text not null default 'original',
    status text not null default 'draft',
    created_at timestamptz not null default now(),
    started_at timestamptz not null default now(),
    submitted_at timestamptz
  );

  create table public.reading_source_occurrences (
    occurrence_id text primary key,
    logical_item_id text not null references public.reading_logical_items(logical_item_id) on delete cascade,
    source_label text not null,
    occurrence_date date not null,
    source_module text not null,
    source_order integer not null,
    source_question_start integer not null,
    source_question_end integer not null
  );
  create table public.reading_full_set_attempts (
    attempt_id uuid primary key default gen_random_uuid(),
    student_id uuid not null,
    full_set_id text not null,
    status text not null default 'in_progress',
    current_module smallint not null default 1,
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create unique index reading_full_set_one_active_attempt
    on public.reading_full_set_attempts(student_id, full_set_id)
    where status = 'in_progress';
  create table public.reading_full_set_module_attempts (
    module_attempt_id uuid primary key default gen_random_uuid(),
    attempt_id uuid not null,
    module_number smallint not null,
    status text not null default 'preparing',
    time_limit_seconds integer not null,
    started_at timestamptz,
    deadline_at timestamptz,
    submitted_at timestamptz,
    submission_reason text,
    answer_revision bigint not null default 0,
    total_points integer not null default 0,
    correct_points integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (attempt_id, module_number)
  );

  create or replace function public.reading_attempt_result_json(p_attempt_id uuid)
  returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object(
      'attemptId', attempt.attempt_id,
      'logicalItemId', attempt.logical_item_id,
      'taskType', attempt.task_type,
      'status', attempt.status
    ) from public.reading_attempts attempt where attempt.attempt_id = p_attempt_id;
  $$;

  create or replace function public.reading_occurrence_full_set_id(
    p_occurrence_date date,
    p_source_label text
  ) returns text language plpgsql immutable set search_path = '' as $$
  declare
    v_match text[];
  begin
    v_match := regexp_match(p_source_label, '^(\\d{1,2})\\.(\\d{1,2})([A-Za-z]*)$');
    if v_match is null
      or v_match[1]::integer <> extract(month from p_occurrence_date)::integer
      or v_match[2]::integer <> extract(day from p_occurrence_date)::integer then
      return null;
    end if;
    return to_char(p_occurrence_date, 'YYYYMMDD') || v_match[3];
  end;
  $$;

  create or replace function public.reading_full_set_module_time_limit(
    p_full_set_id text,
    p_module_number smallint
  ) returns integer language sql stable as $$
    select case
      when p_full_set_id in ('${FS_A}', '${FS_B}') and p_module_number = 1 then 1230
      when p_full_set_id in ('${FS_A}', '${FS_B}') and p_module_number = 2 then 540
      else null
    end;
  $$;

  create or replace function public.reading_full_set_attempt_json(p_attempt_id uuid)
  returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object(
      'attemptId', attempt.attempt_id,
      'fullSetId', attempt.full_set_id,
      'status', attempt.status,
      'currentModule', attempt.current_module,
      'completedAt', attempt.completed_at,
      'module1', (
        select jsonb_build_object(
          'moduleAttemptId', module_attempt.module_attempt_id,
          'moduleNumber', 1,
          'status', module_attempt.status
        )
        from public.reading_full_set_module_attempts module_attempt
        where module_attempt.attempt_id = attempt.attempt_id and module_attempt.module_number = 1
      ),
      'module2', (
        select jsonb_build_object(
          'moduleAttemptId', module_attempt.module_attempt_id,
          'moduleNumber', 2,
          'status', module_attempt.status
        )
        from public.reading_full_set_module_attempts module_attempt
        where module_attempt.attempt_id = attempt.attempt_id and module_attempt.module_number = 2
      )
    ) from public.reading_full_set_attempts attempt where attempt.attempt_id = p_attempt_id;
  $$;

  create or replace function public.reconcile_reading_full_set_attempt(p_attempt_id uuid)
  returns void language plpgsql security definer set search_path = '' as $$
  begin
    return;
  end;
  $$;

  insert into public.profiles(id, role) values
    ('${ADMIN}', 'admin'),
    ('${TEACHER}', 'teacher'),
    ('${STUDENT}', 'student'),
    ('${STUDENT2}', 'student'),
    ('${STUDENT3}', 'student');

  insert into public.reading_logical_items(logical_item_id, module) values
    ('${CTW}', 'ctw'),
    ('${RDL}', 'rdl'),
    ('${RAP}', 'rap'),
    ('${RAP2}', 'rap'),
    ('${CTW_OTHER}', 'ctw');

  insert into public.reading_source_occurrences(
    occurrence_id, logical_item_id, source_label, occurrence_date,
    source_module, source_order, source_question_start, source_question_end
  ) values
    ('occ-a-m1-1', '${CTW}', '1.1A', '2026-01-01', 'm1', 1, 1, 10),
    ('occ-a-m1-2', '${RDL}', '1.1A', '2026-01-01', 'm1', 2, 11, 20),
    ('occ-a-m1-3', '${RAP}', '1.1A', '2026-01-01', 'm1', 3, 21, 35),
    ('occ-a-m2-1', '${RAP2}', '1.1A', '2026-01-01', 'm2', 1, 1, 15),
    ('occ-b-m1-1', '${CTW_OTHER}', '1.1B', '2026-01-01', 'm1', 1, 1, 10);

  insert into public.writing_assignments(
    assignment_id, task_type, question_source, question_id, question_snapshot, status
  ) values
    ('${FULL_ASSIGNMENT}', 'full_set', 'question_bank', '${FS_A}',
      '{"item_id":"${FS_A}","item_type":"full_set"}'::jsonb, 'active'),
    ('${FULL_WITHDRAWN}', 'full_set', 'question_bank', '${FS_A}',
      '{"item_id":"${FS_A}","item_type":"full_set"}'::jsonb, 'withdrawn'),
    ('${FULL_OTHER}', 'full_set', 'question_bank', '${FS_B}',
      '{"item_id":"${FS_B}","item_type":"full_set"}'::jsonb, 'active');

  insert into public.writing_assignment_students(assignment_id, student_id)
  select assignment.assignment_id, student.id
  from public.writing_assignments assignment
  cross join public.profiles student
  where student.role = 'student';
`;

async function freshDb() {
  const db = new PGlite();
  await db.exec(FIXTURE);
  await db.exec(PHASE1);
  await db.exec(PHASE2);
  await db.exec(PHASE3);
  return db;
}

async function claim(db, userId) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
}

async function setFlag(db, enabled) {
  await db.query(
    "update public.practice_entitlement_runtime_config set enforcement_enabled = $1 where singleton = true",
    [enabled]
  );
}

async function createFullSet(db, fullSetId, assignmentId = null) {
  return (await db.query(
    "select public.get_or_create_reading_full_set_attempt_with_assignment($1, $2) as attempt",
    [fullSetId, assignmentId]
  )).rows[0].attempt;
}

async function createFullSetLegacy(db, fullSetId) {
  return (await db.query(
    "select public.get_or_create_reading_full_set_attempt($1) as attempt",
    [fullSetId]
  )).rows[0].attempt;
}

async function completeFullSet(db, attemptId) {
  await db.query(
    `update public.reading_full_set_attempts
     set status = 'completed', current_module = 2, completed_at = clock_timestamp()
     where attempt_id = $1`,
    [attemptId]
  );
}

async function markModule1Submitted(db, attemptId) {
  await db.query(
    `update public.reading_full_set_module_attempts
     set status = 'submitted', submitted_at = clock_timestamp(),
         submission_reason = 'manual', total_points = 35, correct_points = 0
     where attempt_id = $1 and module_number = 1`,
    [attemptId]
  );
  await db.query(
    `update public.reading_full_set_attempts
     set current_module = 2
     where attempt_id = $1 and status = 'in_progress'`,
    [attemptId]
  );
}

async function insertUnlock(db, studentId, taskType, itemId) {
  await db.query(
    `insert into public.student_practice_unlocks(student_id, task_type, item_id, source)
     values ($1, $2, $3, 'manual_test')`,
    [studentId, taskType, itemId]
  );
}

async function unlockCount(db, studentId, taskType, itemId) {
  return (await db.query(
    `select count(*)::integer as n from public.student_practice_unlocks
     where student_id = $1 and task_type = $2 and item_id = $3`,
    [studentId, taskType, itemId]
  )).rows[0].n;
}

async function unlockTotal(db, studentId) {
  return (await db.query(
    "select count(*)::integer as n from public.student_practice_unlocks where student_id = $1",
    [studentId]
  )).rows[0].n;
}

async function eventRows(db, studentId) {
  return (await db.query(
    `select operation, reason, item_id, request_id
     from public.student_practice_entitlement_events
     where student_id = $1 order by event_id`,
    [studentId]
  )).rows;
}

async function remaining(db, studentId, kind) {
  return (await db.query(
    `select coalesce(entitlement.remaining, defaults.default_remaining)::integer as remaining
     from public.practice_entitlement_defaults defaults
     left join public.student_practice_entitlements entitlement
       on entitlement.student_id = $1 and entitlement.entitlement_kind = defaults.entitlement_kind
     where defaults.entitlement_kind = $2`,
    [studentId, kind]
  )).rows[0]?.remaining;
}

test("v3 migration is additive and does not replace the Full Set engine", () => {
  assert.equal((PHASE3.match(/^begin;/gm) ?? []).length, 1);
  assert.equal((PHASE3.match(/^commit;/gm) ?? []).length, 1);
  assert.equal((PHASE3.match(/\$\$/g) ?? []).length % 2, 0);

  assert.match(PHASE3, /unlock_reading_full_set_items/);
  assert.match(PHASE3, /practice_entitlement_full_set_completion_guard/);
  assert.match(PHASE3, /get_or_create_reading_full_set_attempt_with_assignment/);
  assert.match(PHASE3, /FULL_SET_ASSIGNMENT_REQUIRED/);
  assert.match(PHASE3, /FULL_SET_ASSIGNMENT_NOT_AVAILABLE/);
  assert.match(PHASE3, /practice_entitlement_assignment_grants/);
  assert.match(PHASE3, /practice_entitlement_enforcement_enabled/);
  assert.match(PHASE3, /reading_occurrence_full_set_id/);
  assert.match(PHASE3, /student_practice_unlocks/);
  assert.match(PHASE3, /full_set_completion/);
  assert.doesNotMatch(PHASE3, /insert\s+into\s+public\.reading_full_set_answers/i);
  assert.doesNotMatch(PHASE3, /update\s+public\.reading_full_set_answers/i);

  assert.doesNotMatch(PHASE3, /create or replace function public\.finalize_reading_full_set_module/);
  assert.doesNotMatch(PHASE3, /create or replace function public\.submit_reading_full_set_module/);
  assert.doesNotMatch(PHASE3, /create or replace function public\.activate_reading_full_set_module/);
  assert.doesNotMatch(PHASE3, /create or replace function public\.save_reading_full_set_occurrence_answers/);
  assert.doesNotMatch(PHASE3, /create or replace function public\.prepare_reading_full_set_module/);
  assert.doesNotMatch(PHASE3, /create or replace function public\.reconcile_reading_full_set_attempt/);
  assert.doesNotMatch(PHASE3, /create or replace function public\.reading_full_set_attempt_json/);
});

test("switch OFF preserves Student Full Set creation and does not auto-unlock", async () => {
  const db = await freshDb();
  try {
    await claim(db, STUDENT);
    await setFlag(db, false);
    const attempt = await createFullSet(db, FS_A);
    assert.equal(attempt.created, true);
    await completeFullSet(db, attempt.attemptId);
    assert.equal(await unlockTotal(db, STUDENT), 0);

    await claim(db, TEACHER);
    const teacherAttempt = await createFullSet(db, FS_A);
    assert.equal(teacherAttempt.created, true);
    await completeFullSet(db, teacherAttempt.attemptId);
    assert.equal(await unlockTotal(db, TEACHER), 0);

    await claim(db, STUDENT2);
    const legacy = await createFullSetLegacy(db, FS_A);
    assert.equal(legacy.created, true);

    // A historical in-progress attempt created while OFF can resume after ON.
    await claim(db, STUDENT3);
    const historical = await createFullSet(db, FS_A);
    assert.equal(historical.created, true);
    await setFlag(db, true);
    const resumedHistorical = await createFullSet(db, FS_A, null);
    assert.equal(resumedHistorical.created, false);
    assert.equal(resumedHistorical.attemptId, historical.attemptId);
  } finally {
    await db.close();
  }
});

test("switch ON requires a valid assignment for the first Student attempt, while resume/retake/teacher stay compatible", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, true);
    await claim(db, STUDENT);

    await assert.rejects(createFullSet(db, FS_A), /FULL_SET_ASSIGNMENT_REQUIRED/);
    await assert.rejects(
      createFullSet(db, FS_A, FULL_WITHDRAWN),
      /FULL_SET_ASSIGNMENT_NOT_AVAILABLE/
    );
    await assert.rejects(
      createFullSet(db, FS_A, FULL_OTHER),
      /FULL_SET_ASSIGNMENT_NOT_AVAILABLE/
    );

    const first = await createFullSet(db, FS_A, FULL_ASSIGNMENT);
    assert.equal(first.created, true);
    const resumed = await createFullSet(db, FS_A, null);
    assert.equal(resumed.created, false);
    assert.equal(resumed.attemptId, first.attemptId);

    await completeFullSet(db, first.attemptId);
    const retake = await createFullSet(db, FS_A, null);
    assert.equal(retake.created, true);
    assert.notEqual(retake.attemptId, first.attemptId);

    await claim(db, TEACHER);
    assert.equal((await createFullSet(db, FS_A, null)).created, true);
    await claim(db, ADMIN);
    assert.equal((await createFullSet(db, FS_B, null)).created, true);
  } finally {
    await db.close();
  }
});

test("v3 API/UI wiring carries the assignment hint and never enables the switch", () => {
  const api = read("app/api/reading/full-set-attempts/route.ts");
  assert.match(api, /get_or_create_reading_full_set_attempt_with_assignment/);
  assert.match(api, /p_assignment_id/);
  assert.match(api, /assignmentId/);
  assert.match(api, /FULL_SET_ASSIGNMENT_REQUIRED/);
  assert.match(api, /FULL_SET_ASSIGNMENT_NOT_AVAILABLE/);

  assert.match(read("app/student/reading/full-sets/[fullSetId]/page.tsx"), /assignmentId/);
  assert.match(read("components/reading/ReadingFullSetDetail.tsx"), /assignmentId/);
  assert.match(read("components/reading/ReadingFullSetDetail.tsx"), /assignmentId: assignmentId/);
  assert.match(read("lib/studentAssignmentPractice.ts"), /full_set[\s\S]{0,180}withAssignmentHint/);
  assert.doesNotMatch(PHASE3, /set enforcement_enabled = true/i);

  const { studentAssignmentPracticeHref } = require("../lib/studentAssignmentPractice.ts");
  const href = studentAssignmentPracticeHref(
    {
      assignmentId: FULL_ASSIGNMENT,
      itemId: FS_A,
      taskType: "full_set"
    },
    `/student/assignments/${FULL_ASSIGNMENT}`
  );
  assert.match(href, new RegExp(`assignmentId=${FULL_ASSIGNMENT}`));
  assert.match(href, /returnTo=%2Fstudent%2Fassignments%2F/);
});

test("only full completion unlocks all actual items, including unanswered, with no quota spend or duplicates", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, true);
    await claim(db, STUDENT);
    const attempt = await createFullSet(db, FS_A, FULL_ASSIGNMENT);
    await markModule1Submitted(db, attempt.attemptId);
    assert.equal(await unlockTotal(db, STUDENT), 0);

    // Existing unlock is preserved and not duplicated.
    await insertUnlock(db, STUDENT, "rdl", RDL);
    const eventsBefore = (await eventRows(db, STUDENT)).length;

    await completeFullSet(db, attempt.attemptId);
    assert.equal(await unlockCount(db, STUDENT, "ctw", CTW), 1);
    assert.equal(await unlockCount(db, STUDENT, "rdl", RDL), 1);
    assert.equal(await unlockCount(db, STUDENT, "rap", RAP), 1);
    assert.equal(await unlockCount(db, STUDENT, "rap", RAP2), 1);
    assert.equal(await unlockCount(db, STUDENT, "ctw", CTW_OTHER), 0);
    assert.equal(await unlockTotal(db, STUDENT), 4);

    const events = await eventRows(db, STUDENT);
    assert.equal(events.length, eventsBefore + 3);
    assert.ok(events.slice(eventsBefore).every((event) =>
      event.operation === "unlock" && event.reason === "full_set_completion"
    ));
    assert.equal(events.some((event) => event.operation === "spend"), false);
    assert.equal(await remaining(db, STUDENT, "ctw"), 5);
    assert.equal(await remaining(db, STUDENT, "rdl"), 5);
    assert.equal(await remaining(db, STUDENT, "rap"), 5);

    // Repeat/concurrent finalize and helper calls are idempotent.
    const concurrent = await Promise.allSettled([
      completeFullSet(db, attempt.attemptId),
      completeFullSet(db, attempt.attemptId)
    ]);
    assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 2);
    await db.query(
      "select public.unlock_reading_full_set_items($1, true)",
      [attempt.attemptId]
    );
    assert.equal(await unlockTotal(db, STUDENT), 4);
    assert.equal((await eventRows(db, STUDENT)).length, events.length);

    await claim(db, TEACHER);
    const teacherAttempt = await createFullSet(db, FS_A, null);
    await completeFullSet(db, teacherAttempt.attemptId);
    assert.equal(await unlockTotal(db, TEACHER), 0);
  } finally {
    await db.close();
  }
});

test("direct RPCs cannot bypass assignment checks or call the internal unlock helper", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, true);
    await claim(db, STUDENT3);
    await assert.rejects(createFullSetLegacy(db, FS_A), /FULL_SET_ASSIGNMENT_REQUIRED/);
    await assert.rejects(
      createFullSet(db, FS_A, "99999999-0000-4000-8000-000000000001"),
      /FULL_SET_ASSIGNMENT_NOT_AVAILABLE/
    );

    await db.exec("set role authenticated");
    await assert.rejects(
      db.query("select public.unlock_reading_full_set_items($1, false)", [
        "99999999-0000-4000-8000-000000000001"
      ]),
      /permission denied/
    );
    await db.exec("reset role");
  } finally {
    await db.close();
  }
});

v3BackfillTest("v3 historical backfill only unlocks completed student Full Sets and is idempotent", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, false);

    await claim(db, STUDENT);
    const studentA = await createFullSet(db, FS_A, null);
    await completeFullSet(db, studentA.attemptId);
    const studentB = await createFullSet(db, FS_B, null);
    await completeFullSet(db, studentB.attemptId);

    await claim(db, STUDENT2);
    // Teacher-assigned historical completion is included by the same backfill.
    const student2A = await createFullSet(db, FS_A, FULL_ASSIGNMENT);
    await completeFullSet(db, student2A.attemptId);
    await insertUnlock(db, STUDENT2, "rdl", RDL);

    await claim(db, STUDENT3);
    const incomplete = await createFullSet(db, FS_A, null);
    assert.equal(incomplete.created, true);
    // Completed but no resolvable occurrence identity: must be skipped, not guessed.
    await db.query(
      `insert into public.reading_full_set_attempts(
         student_id, full_set_id, status, current_module, completed_at
       ) values ($1, '20260101Z', 'completed', 2, clock_timestamp())`,
      [STUDENT3]
    );

    await claim(db, TEACHER);
    const teacherA = await createFullSet(db, FS_A, null);
    await completeFullSet(db, teacherA.attemptId);

    const beforeEntitlements = (await db.query(
      "select count(*)::integer as n from public.student_practice_entitlements"
    )).rows[0].n;
    const beforeEvents = (await db.query(
      "select count(*)::integer as n from public.student_practice_entitlement_events"
    )).rows[0].n;

    await db.exec(V3_BACKFILL_DRY);
    await db.exec(V3_BACKFILL_APPLY);

    assert.equal(await unlockTotal(db, STUDENT), 5);
    assert.equal(await unlockTotal(db, STUDENT2), 4);
    assert.equal(await unlockTotal(db, STUDENT3), 0);
    assert.equal(await unlockTotal(db, TEACHER), 0);
    assert.equal(await unlockCount(db, STUDENT2, "rdl", RDL), 1);
    assert.equal(
      (await db.query(
        "select count(*)::integer as n from public.student_practice_entitlements"
      )).rows[0].n,
      beforeEntitlements
    );
    assert.equal(
      (await db.query(
        "select count(*)::integer as n from public.student_practice_entitlement_events"
      )).rows[0].n,
      beforeEvents
    );

    const beforeRerun = (await db.query(
      "select count(*)::integer as n from public.student_practice_unlocks"
    )).rows[0].n;
    await db.exec(V3_BACKFILL_APPLY);
    assert.equal(
      (await db.query(
        "select count(*)::integer as n from public.student_practice_unlocks"
      )).rows[0].n,
      beforeRerun
    );
    await db.exec(V3_BACKFILL_VERIFY);
  } finally {
    await db.close();
  }
});

phase3SqlTest("manual v3 preflight and verify SQL execute successfully", async () => {
  const db = await freshDb();
  try {
    await db.exec(V3_PREFLIGHT);
    await db.exec(V3_VERIFY);
  } finally {
    await db.close();
  }
});
