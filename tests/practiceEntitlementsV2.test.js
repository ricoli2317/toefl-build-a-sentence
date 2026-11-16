const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { PGlite } = require("@electric-sql/pglite");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const PHASE1 = read("supabase/student_practice_entitlements_v1_20261114.sql");
const PHASE2 = read("supabase/student_practice_entitlements_v2_20261114.sql");

// The one-time historical backfill is a manual production data operation and
// intentionally lives outside Git. Set TPS_MANUAL_SQL_DIR to execute its
// offline checks.
const MANUAL_SQL_DIR = process.env.TPS_MANUAL_SQL_DIR?.trim() ?? "";
const readManual = (file) => {
  if (!MANUAL_SQL_DIR) return null;
  try {
    return fs.readFileSync(path.join(MANUAL_SQL_DIR, file), "utf8");
  } catch {
    return null;
  }
};
const BACKFILL_DRY = readManual("student_practice_entitlements_v2_backfill_dry_run_20261114.sql");
const BACKFILL_APPLY = readManual("student_practice_entitlements_v2_backfill_apply_20261114.sql");
const BACKFILL_VERIFY = readManual("student_practice_entitlements_v2_backfill_verify_20261114.sql");
const PHASE2_PREFLIGHT = readManual("preflight_phase2.sql");
const PHASE2_VERIFY = readManual("verify_phase2.sql");
const PHASE2_ROLLBACK = readManual("rollback_test_phase2.sql");
const manualSqlAvailable = Boolean(BACKFILL_DRY && BACKFILL_APPLY && BACKFILL_VERIFY);
const phase2SqlAvailable = Boolean(PHASE2_PREFLIGHT && PHASE2_VERIFY && PHASE2_ROLLBACK);
const manualSqlTest = (name, fn) => test(name, {
  skip: manualSqlAvailable ? false : "Set TPS_MANUAL_SQL_DIR to the local manual SQL directory"
}, fn);
const phase2SqlTest = (name, fn) => test(name, {
  skip: phase2SqlAvailable ? false : "Set TPS_MANUAL_SQL_DIR to the local manual SQL directory"
}, fn);

const ADMIN = "10000000-0000-4000-8000-000000000001";
const TEACHER = "10000000-0000-4000-8000-000000000002";
const STUDENT = "10000000-0000-4000-8000-000000000003";
const STUDENT2 = "10000000-0000-4000-8000-000000000004";
const STUDENT3 = "10000000-0000-4000-8000-000000000005";
const STUDENT4 = "10000000-0000-4000-8000-000000000006";

const ITEM_BAS1 = "20000000-0000-4000-8000-000000000001";
const ITEM_BAS2 = "20000000-0000-4000-8000-000000000002";
const ITEM_BAS3 = "20000000-0000-4000-8000-000000000003";
const ITEM_BAS4 = "20000000-0000-4000-8000-000000000004";
const ITEM_BAS5 = "20000000-0000-4000-8000-000000000005";
const ITEM_BAS6 = "20000000-0000-4000-8000-000000000006";
const ITEM_EMAIL1 = "30000000-0000-4000-8000-000000000001";
const ITEM_EMAIL2 = "30000000-0000-4000-8000-000000000002";
const ITEM_EMAIL3 = "30000000-0000-4000-8000-000000000003";
const ITEM_AD = "30000000-0000-4000-8000-000000000004";

const CTW = "reading-ctw-aaaaaaaaaaaaaaaaaaaaaaaa";
const CTW2 = "reading-ctw-bbbbbbbbbbbbbbbbbbbbbbbb";
const RDL = "reading-rdl-cccccccccccccccccccccccc";
const RAP = "reading-rap-dddddddddddddddddddddddd";
const RAP2 = "reading-rap-eeeeeeeeeeeeeeeeeeeeeeee";

const SET_A = "202601-01-01";
const SET_B = "202602-02-02";
const SET_C = "202601-01-02";
const SET_D = "202601-01-03";
const SET_E = "202601-01-04";
const SET_F = "202601-01-05";

const BAS_ASSIGNMENT = "90000000-0000-4000-8000-000000000001";
const BAS_WITHDRAWN = "90000000-0000-4000-8000-000000000002";
const READING_ASSIGNMENT = "90000000-0000-4000-8000-000000000003";
const READING_WITHDRAWN = "90000000-0000-4000-8000-000000000004";
const EMAIL_ASSIGNMENT = "90000000-0000-4000-8000-000000000005";
const EMAIL_CUSTOM = "90000000-0000-4000-8000-000000000006";

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
    module text not null
  );
  create table public.questions (
    question_id text primary key,
    set_id text not null,
    set_title text
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
  create or replace function public.reading_attempt_result_json(p_attempt_id uuid)
  returns jsonb language sql stable security definer set search_path = '' as $$
    select jsonb_build_object(
      'attemptId', attempt.attempt_id,
      'logicalItemId', attempt.logical_item_id,
      'taskType', attempt.task_type,
      'status', attempt.status,
      'elapsedSeconds', attempt.elapsed_seconds,
      'startedAt', attempt.started_at,
      'submittedAt', attempt.submitted_at,
      'totalPoints', attempt.total_points,
      'correctPoints', attempt.correct_points
    )
    from public.reading_attempts attempt
    where attempt.attempt_id = p_attempt_id;
  $$;

  insert into public.profiles(id, role) values
    ('${ADMIN}', 'admin'),
    ('${TEACHER}', 'teacher'),
    ('${STUDENT}', 'student'),
    ('${STUDENT2}', 'student'),
    ('${STUDENT3}', 'student'),
    ('${STUDENT4}', 'student');

  insert into public.practice_items(item_id, task_type) values
    ('${ITEM_BAS1}', 'build_sentence'),
    ('${ITEM_BAS2}', 'build_sentence'),
    ('${ITEM_BAS3}', 'build_sentence'),
    ('${ITEM_BAS4}', 'build_sentence'),
    ('${ITEM_BAS5}', 'build_sentence'),
    ('${ITEM_BAS6}', 'build_sentence'),
    ('${ITEM_EMAIL1}', 'email'),
    ('${ITEM_EMAIL2}', 'email'),
    ('${ITEM_EMAIL3}', 'email'),
    ('${ITEM_AD}', 'academic_discussion');
  insert into public.practice_item_sources(source_id, item_id, task_type, source_set_id, source_question_id, is_canonical) values
    (gen_random_uuid(), '${ITEM_BAS1}', 'build_sentence', '${SET_A}', null, true),
    (gen_random_uuid(), '${ITEM_BAS1}', 'build_sentence', '${SET_B}', null, false),
    (gen_random_uuid(), '${ITEM_BAS2}', 'build_sentence', '${SET_C}', null, true),
    (gen_random_uuid(), '${ITEM_BAS3}', 'build_sentence', '${SET_D}', null, true),
    (gen_random_uuid(), '${ITEM_BAS4}', 'build_sentence', '${SET_E}', null, true),
    (gen_random_uuid(), '${ITEM_BAS5}', 'build_sentence', '${SET_F}', null, true),
    (gen_random_uuid(), '${ITEM_EMAIL1}', 'email', null, 'email-q1', true),
    (gen_random_uuid(), '${ITEM_EMAIL2}', 'email', null, 'email-q2', true),
    (gen_random_uuid(), '${ITEM_EMAIL3}', 'email', null, 'email-q3', true),
    (gen_random_uuid(), '${ITEM_AD}', 'academic_discussion', null, 'ad-q1', true);

  insert into public.reading_logical_items(logical_item_id, module) values
    ('${CTW}', 'ctw'), ('${CTW2}', 'ctw'), ('${RDL}', 'rdl'),
    ('${RAP}', 'rap'), ('${RAP2}', 'rap');

  insert into public.questions(question_id, set_id, set_title) values
    ('q1', '${SET_A}', 'Set A'),
    ('q2', '${SET_A}', 'Set A'),
    ('q3', '${SET_C}', 'Set C');

  insert into public.writing_assignments(
    assignment_id, task_type, question_source, question_id, question_snapshot, status
  ) values
    ('${BAS_ASSIGNMENT}', 'build_sentence', 'question_bank', '${ITEM_BAS1}',
      '{"item_id":"${ITEM_BAS1}","item_type":"build_sentence","source_set_id":"${SET_A}"}'::jsonb, 'active'),
    ('${BAS_WITHDRAWN}', 'build_sentence', 'question_bank', '${ITEM_BAS1}',
      '{"item_id":"${ITEM_BAS1}","item_type":"build_sentence","source_set_id":"${SET_A}"}'::jsonb, 'withdrawn'),
    ('${READING_ASSIGNMENT}', 'ctw', 'question_bank', '${CTW}',
      '{"item_id":"${CTW}","item_type":"ctw"}'::jsonb, 'active'),
    ('${READING_WITHDRAWN}', 'ctw', 'question_bank', '${CTW}',
      '{"item_id":"${CTW}","item_type":"ctw"}'::jsonb, 'withdrawn'),
    ('${EMAIL_ASSIGNMENT}', 'email', 'question_bank', 'email-q1',
      '{"item_id":"${ITEM_EMAIL1}","item_type":"email","question_id":"email-q1","set_title":"Email"}'::jsonb, 'active'),
    ('${EMAIL_CUSTOM}', 'email', 'custom', null,
      '{"item_type":"email","question_id":"custom-email-q1","set_title":"Custom"}'::jsonb, 'active');

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

async function basStart(db, setId, assignmentId = null) {
  return (await db.query(
    "select public.student_start_build_sentence_practice($1, $2) as access",
    [setId, assignmentId]
  )).rows[0].access;
}

async function recordPreEnableBasStart(db, studentId, setId, assignmentId = null) {
  return (await db.query(
    "select public.record_pre_enable_build_sentence_start($1, $2, $3) as result",
    [studentId, setId, assignmentId]
  )).rows[0].result;
}

async function readingStart(db, logicalItemId, assignmentId = null) {
  return (await db.query(
    "select public.get_or_create_reading_attempt_with_assignment($1, $2) as attempt",
    [logicalItemId, assignmentId]
  )).rows[0].attempt;
}

async function readingRetake(db, attemptId) {
  return (await db.query(
    "select public.retake_reading_attempt($1) as attempt",
    [attemptId]
  )).rows[0].attempt;
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

async function unlockCount(db, studentId, taskType, itemId) {
  return (await db.query(
    `select count(*)::integer as n from public.student_practice_unlocks
     where student_id = $1 and task_type = $2 and item_id = $3`,
    [studentId, taskType, itemId]
  )).rows[0].n;
}

async function eventRows(db, studentId) {
  return (await db.query(
    `select operation, reason, previous_remaining, new_remaining, item_id, assignment_id
     from public.student_practice_entitlement_events
     where student_id = $1 order by event_id`,
    [studentId]
  )).rows;
}

async function insertWritingAttempt(db, {
  userId,
  taskType,
  questionId,
  assignmentId = null,
  attemptKind = "original",
  status = "draft"
}) {
  return (await db.query(
    `insert into public.writing_attempts(
       user_id, task_type, question_id, assignment_id, attempt_kind, status
     ) values ($1, $2, $3, $4, $5, $6)
     returning attempt_id`,
    [userId, taskType, questionId, assignmentId, attemptKind, status]
  )).rows[0].attempt_id;
}

async function insertAttempt(db, studentId, setId) {
  return (await db.query(
    `insert into public.attempts(student_id, set_id, set_title)
     values ($1, $2, 'Set ') returning attempt_id`,
    [studentId, setId]
  )).rows[0].attempt_id;
}

async function insertAnswer(db, attemptId, studentId, questionId, setId) {
  return db.query(
    `insert into public.attempt_answers(
       attempt_id, question_id, student_id, set_id,
       question_order, prompt, submitted_order_text, correct_order_text, is_correct
     ) values ($1, $2, $3, $4, 0, '', '', '', false)`,
    [attemptId, questionId, studentId, setId]
  );
}

test("phase-2 migration stays inside the six ordinary task types", () => {
  assert.equal((PHASE2.match(/^begin;/gm) ?? []).length, 1);
  assert.equal((PHASE2.match(/^commit;/gm) ?? []).length, 1);
  assert.equal((PHASE2.match(/\$\$/g) ?? []).length % 2, 0);

  assert.match(PHASE2, /create table if not exists public\.practice_entitlement_runtime_config/);
  assert.match(PHASE2, /enforcement_enabled boolean not null default false/);
  assert.match(PHASE2, /on conflict \(singleton\) do nothing/);
  assert.match(PHASE2, /student_start_build_sentence_practice/);
  assert.match(PHASE2, /record_pre_enable_build_sentence_start/);
  assert.match(PHASE2, /pre_enforcement_start/);
  assert.match(PHASE2, /student_assert_bas_submission_authorized/);
  assert.match(PHASE2, /get_or_create_reading_attempt_with_assignment/);
  assert.match(PHASE2, /create or replace function public\.retake_reading_attempt/);
  assert.match(PHASE2, /student_ensure_writing_practice_unlock/);
  assert.match(PHASE2, /practice_entitlement_writing_attempt_guard/);
  assert.match(PHASE2, /practice_entitlement_attempt_guard/);
  assert.match(PHASE2, /practice_entitlement_attempt_answer_guard/);
  assert.match(PHASE2, /pg_advisory_xact_lock\(hashtextextended\(p_student_id::text, 0\)\)/);
  assert.match(PHASE2, /item\.item_id::text = new\.item_id/);
  assert.match(PHASE2, /PRACTICE_ENTITLEMENT_EXHAUSTED/);
  assert.match(PHASE2, /PRACTICE_ASSIGNMENT_NOT_AVAILABLE/);
  assert.match(PHASE2, /PRACTICE_QUESTION_NOT_IN_SET/);
  assert.match(PHASE2, /WRITING_ATTEMPT_IDENTITY_IMMUTABLE/);
  assert.match(PHASE2, /ATTEMPT_ANSWER_IDENTITY_IMMUTABLE/);

  assert.doesNotMatch(PHASE2, /create or replace function public\.get_or_create_reading_full_set_attempt/);
  assert.doesNotMatch(PHASE2, /create or replace function public\.get_or_create_reading_wrongbook_attempt/);
  assert.doesNotMatch(PHASE2, /create or replace function public\.get_or_create_reading_full_set_wrongbook_attempt/);
  assert.doesNotMatch(PHASE2, /reading_question_category/);
  assert.doesNotMatch(PHASE2, /reading_full_set_attempts/);
});

manualSqlTest("one-time backfill files remain manual and only write unlocks", () => {
  for (const backfill of [BACKFILL_DRY, BACKFILL_APPLY, BACKFILL_VERIFY]) {
    assert.doesNotMatch(backfill, /update\s+public\.(attempts|writing_attempts|reading_attempts|student_practice_entitlements)\b/i);
    assert.doesNotMatch(backfill, /delete\s+from\s+public\./i);
  }
  assert.doesNotMatch(BACKFILL_DRY, /insert\s+into\s+public\.student_practice_unlocks/i);
  assert.doesNotMatch(BACKFILL_VERIFY, /insert\s+into\s+public\.student_practice_unlocks/i);
  assert.match(BACKFILL_APPLY, /insert into public\.student_practice_unlocks/);
  assert.doesNotMatch(BACKFILL_APPLY, /insert\s+into\s+public\.(student_practice_entitlements|student_practice_entitlement_events)/i);
  assert.match(BACKFILL_APPLY, /lower\(btrim\(attempt\.set_id::text\)\) not like 'grammar-%'/);
  assert.match(BACKFILL_APPLY, /assignment\.question_source = 'question_bank'/);
});

test("phase-2 API/UI wiring uses explicit Start, assignment hints and database guards", () => {
  const basStart = read("app/api/sets/[setId]/start/route.ts");
  assert.match(basStart, /requireUserWithRole/);
  assert.match(basStart, /student_start_build_sentence_practice/);
  assert.match(basStart, /record_pre_enable_build_sentence_start/);
  assert.match(basStart, /createServiceSupabase/);
  assert.match(basStart, /p_assignment_id/);
  assert.doesNotMatch(basStart, /export async function GET/);
  assert.doesNotMatch(basStart, /\.from\(/);

  const readingApi = read("app/api/reading/attempts/route.ts");
  assert.match(readingApi, /get_or_create_reading_attempt_with_assignment/);
  assert.match(readingApi, /p_assignment_id/);
  assert.doesNotMatch(readingApi, /rpc\("get_or_create_reading_attempt"/);

  const submissions = read("app/api/submissions/route.ts");
  assert.match(submissions, /student_assert_bas_submission_authorized/);
  assert.match(submissions, /mapPracticeAccessError/);
  assert.match(submissions, /\.eq\("set_id", setId\)[\s\S]{0,120}\.in\("question_id", questionIds\)/);

  const writingRoute = read("app/api/writing/attempts/route.ts");
  assert.match(writingRoute, /student_ensure_writing_practice_unlock/);
  assert.match(writingRoute, /error\.status \?\? 500/);
  assert.match(read("app/api/writing/attempts/[attemptId]/route.ts"), /student_ensure_writing_practice_unlock/);

  const practiceSession = read("components/PracticeSession.tsx");
  assert.match(practiceSession, /requiresPracticeStart/);
  assert.match(practiceSession, /sets\/\$\{encodeURIComponent\(setId\)\}\/start/);
  assert.match(practiceSession, /正在验证练习权限/);
  assert.match(practiceSession, /startStatus === "error"/);

  const readingPractice = read("components/reading/ReadingPractice.tsx");
  assert.match(readingPractice, /assignmentId: assignmentId \|\| null/);
  assert.match(readingPractice, /get_or_create_reading_attempt|api\/reading\/attempts/);

  const assignmentHref = read("lib/studentAssignmentPractice.ts");
  assert.match(assignmentHref, /withAssignmentHint/);
  assert.match(assignmentHref, /assignmentId=\$\{encodeURIComponent\(id\)\}/);
  assert.match(read("lib/writingAttemptLifecycle.ts"), /mapPracticeAccessError/);
  assert.match(read("lib/reading/attemptServer.ts"), /mapPracticeAccessError/);

  const {
    studentAssignmentPracticeHref
  } = require("../lib/studentAssignmentPractice.ts");
  const basHref = studentAssignmentPracticeHref(
    {
      assignmentId: "90000000-0000-4000-8000-000000000001",
      itemId: "item-bas",
      sourceSetId: "202601-01-01",
      taskType: "build_sentence"
    },
    "/student/assignments/90000000-0000-4000-8000-000000000001"
  );
  assert.match(basHref, /assignmentId=90000000-0000-4000-8000-000000000001/);
  assert.match(basHref, /returnTo=%2Fstudent%2Fassignments%2F/);
  const readingHref = studentAssignmentPracticeHref(
    {
      assignmentId: "90000000-0000-4000-8000-000000000003",
      itemId: "reading-ctw-aaaaaaaaaaaaaaaaaaaaaaaa",
      taskType: "ctw"
    },
    null
  );
  assert.match(readingHref, /assignmentId=90000000-0000-4000-8000-000000000003/);
});

phase2SqlTest("manual phase-2 preflight and verify SQL execute successfully", async () => {
  const db = await freshDb();
  try {
    await db.exec(PHASE2_PREFLIGHT);
    await db.exec(PHASE2_VERIFY);
  } finally {
    await db.close();
  }
});

phase2SqlTest("manual phase-2 rollback smoke test executes and leaves the switch off", async () => {
  const db = await freshDb();
  try {
    await db.exec(PHASE2_ROLLBACK);
    assert.equal(
      (await db.query(
        "select enforcement_enabled from public.practice_entitlement_runtime_config where singleton = true"
      )).rows[0].enforcement_enabled,
      false
    );
    assert.deepEqual(
      (await db.query(`
        select
          (select count(*)::int from public.student_practice_unlocks) as unlocks,
          (select count(*)::int from public.attempts) as attempts,
          (select count(*)::int from public.reading_attempts) as readings,
          (select count(*)::int from public.student_practice_entitlement_events) as events
      `)).rows[0],
      { unlocks: 0, attempts: 0, readings: 0, events: 0 }
    );
  } finally {
    await db.close();
  }
});

test("phase-2 migration is re-runnable and preserves an already-enabled server switch", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, true);
    await db.exec(PHASE2);
    assert.equal(
      (await db.query(
        "select enforcement_enabled from public.practice_entitlement_runtime_config where singleton = true"
      )).rows[0].enforcement_enabled,
      true
    );
    assert.equal(
      (await db.query(
        "select count(*)::integer as n from public.practice_entitlement_defaults"
      )).rows[0].n,
      8
    );
    assert.match(
      (await db.query(
        "select pg_get_functiondef('public.enforce_student_practice_unlock_identity()'::regprocedure) as definition"
      )).rows[0].definition,
      /item_id::text/
    );
  } finally {
    await db.close();
  }
});

test("feature switch is server-only and cannot be read or changed by a client role", async () => {
  const db = await freshDb();
  try {
    await claim(db, STUDENT);
    await db.exec("set role authenticated");
    await assert.rejects(
      db.query("select enforcement_enabled from public.practice_entitlement_runtime_config"),
      /permission denied/
    );
    await assert.rejects(
      db.query("update public.practice_entitlement_runtime_config set enforcement_enabled = true"),
      /permission denied/
    );
    await db.exec("reset role");
    assert.equal(
      (await db.query(
        "select enforcement_enabled from public.practice_entitlement_runtime_config where singleton = true"
      )).rows[0].enforcement_enabled,
      false
    );
  } finally {
    await db.close();
  }
});

test("feature switch defaults off and leaves all six entry points compatible", async () => {
  const db = await freshDb();
  try {
    await claim(db, STUDENT);
    const access = await basStart(db, SET_A);
    assert.equal(access.charged, false);
    assert.equal(access.enforcementEnabled, false);
    assert.equal(access.unlocked, false);
    assert.equal(await remaining(db, STUDENT, "build_sentence"), 5);
    assert.equal(await unlockCount(db, STUDENT, "build_sentence", ITEM_BAS1), 0);

    // The authenticated start RPC cannot be used to farm free unlocks. Only the
    // service-role marker called by the authenticated BAS API may record the
    // pre-enforcement start.
    await db.exec("set role authenticated");
    await assert.rejects(
      db.query(
        "select public.record_pre_enable_build_sentence_start($1, $2, null)",
        [STUDENT, SET_A]
      ),
      /permission denied/
    );
    await db.exec("reset role");

    const recorded = await recordPreEnableBasStart(db, STUDENT, SET_A);
    assert.equal(recorded.recorded, true);
    assert.equal(recorded.free, true);
    assert.equal(await remaining(db, STUDENT, "build_sentence"), 5);
    assert.equal(await unlockCount(db, STUDENT, "build_sentence", ITEM_BAS1), 1);
    assert.deepEqual(
      (await eventRows(db, STUDENT)).map((event) => ({
        operation: event.operation,
        reason: event.reason
      })),
      [{ operation: "unlock", reason: "pre_enforcement_start" }]
    );

    await insertWritingAttempt(db, {
      userId: STUDENT,
      taskType: "email",
      questionId: "email-q1"
    });
    assert.equal(await remaining(db, STUDENT, "email"), 5);
    assert.equal(await unlockCount(db, STUDENT, "email", ITEM_EMAIL1), 0);

    // The pre-enforcement start marker is a free unlock, so the same started
    // practice remains startable and submittable after the switch turns on.
    await insertAttempt(db, STUDENT, SET_A);
    await setFlag(db, true);
    const afterEnable = await basStart(db, SET_A);
    assert.equal(afterEnable.allowed, true);
    assert.equal(afterEnable.charged, false);
    await insertAttempt(db, STUDENT, SET_A);
    await setFlag(db, false);

    const reading = await readingStart(db, CTW);
    assert.equal(reading.created, true);
    assert.equal(await remaining(db, STUDENT, "ctw"), 5);
    assert.equal(await unlockCount(db, STUDENT, "ctw", CTW), 0);
  } finally {
    await db.close();
  }
});

test("BAS first start charges once, cross-month unlock is shared, and assignment/historical starts are free", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, true);
    await claim(db, STUDENT);

    const first = await basStart(db, SET_A);
    assert.equal(first.charged, true);
    assert.equal(first.remaining, 4);
    assert.equal(await unlockCount(db, STUDENT, "build_sentence", ITEM_BAS1), 1);

    const crossMonth = await basStart(db, SET_B);
    assert.equal(crossMonth.charged, false);
    assert.equal(crossMonth.remaining, 4);

    const repeat = await basStart(db, SET_A);
    assert.equal(repeat.charged, false);
    assert.equal(repeat.remaining, 4);

    const secondItem = await basStart(db, SET_C);
    assert.equal(secondItem.charged, true);
    assert.equal(secondItem.remaining, 3);

    await db.query(
      "update public.student_practice_entitlements set remaining = 0 where student_id = $1 and entitlement_kind = 'build_sentence'",
      [STUDENT]
    );
    await assert.rejects(basStart(db, SET_D), /PRACTICE_ENTITLEMENT_EXHAUSTED/);
    assert.equal(await unlockCount(db, STUDENT, "build_sentence", ITEM_BAS3), 0);
    assert.equal((await basStart(db, SET_A)).charged, false);

    await claim(db, TEACHER);
    const teacherAccess = await basStart(db, SET_E);
    assert.equal(teacherAccess.charged, false);
    assert.equal(await unlockCount(db, TEACHER, "build_sentence", ITEM_BAS4), 0);
    assert.equal(
      (await db.query(
        "select count(*)::integer as n from public.student_practice_entitlements where student_id = $1",
        [TEACHER]
      )).rows[0].n,
      0
    );

    await claim(db, ADMIN);
    const adminAccess = await basStart(db, SET_F);
    assert.equal(adminAccess.charged, false);
    assert.equal(await unlockCount(db, ADMIN, "build_sentence", ITEM_BAS5), 0);

    await claim(db, STUDENT2);
    const assignmentAccess = await basStart(db, SET_A, BAS_ASSIGNMENT);
    assert.equal(assignmentAccess.free, true);
    assert.equal(assignmentAccess.charged, false);
    assert.equal(await remaining(db, STUDENT2, "build_sentence"), 5);
    assert.equal(await unlockCount(db, STUDENT2, "build_sentence", ITEM_BAS1), 1);

    await db.query(
      "update public.writing_assignments set status = 'withdrawn' where assignment_id = $1",
      [BAS_ASSIGNMENT]
    );
    assert.equal((await basStart(db, SET_A, BAS_ASSIGNMENT)).allowed, true);

    await claim(db, STUDENT3);
    await assert.rejects(
      basStart(db, SET_A, BAS_WITHDRAWN),
      /PRACTICE_ASSIGNMENT_NOT_AVAILABLE/
    );
    assert.equal(await remaining(db, STUDENT3, "build_sentence"), 5);
    assert.equal(await unlockCount(db, STUDENT3, "build_sentence", ITEM_BAS1), 0);

    await setFlag(db, false);
    await insertAttempt(db, STUDENT4, SET_B);
    await setFlag(db, true);
    await claim(db, STUDENT4);
    const historical = await basStart(db, SET_A);
    assert.equal(historical.free, true);
    assert.equal(historical.charged, false);
    assert.equal(await remaining(db, STUDENT4, "build_sentence"), 5);
    assert.equal(await unlockCount(db, STUDENT4, "build_sentence", ITEM_BAS1), 1);
  } finally {
    await db.close();
  }
});

test("BAS concurrent starts cannot double-charge or overdraw", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, true);
    await claim(db, STUDENT3);

    const sameItem = await Promise.allSettled([
      basStart(db, SET_C),
      basStart(db, SET_C)
    ]);
    assert.equal(sameItem.filter((entry) => entry.status === "fulfilled").length, 2);
    assert.equal(sameItem.filter((entry) =>
      entry.status === "fulfilled" && entry.value.charged
    ).length, 1);
    assert.equal(await remaining(db, STUDENT3, "build_sentence"), 4);
    assert.equal(await unlockCount(db, STUDENT3, "build_sentence", ITEM_BAS2), 1);

    await db.query(
      "update public.student_practice_entitlements set remaining = 1 where student_id = $1 and entitlement_kind = 'build_sentence'",
      [STUDENT3]
    );
    const differentItems = await Promise.allSettled([
      basStart(db, SET_D),
      basStart(db, SET_E)
    ]);
    assert.equal(
      differentItems.filter((entry) => entry.status === "fulfilled").length,
      1
    );
    assert.equal(
      differentItems.filter((entry) => entry.status === "rejected").length,
      1
    );
    assert.equal(await remaining(db, STUDENT3, "build_sentence"), 0);
    assert.equal(
      (await db.query(
        `select count(*)::integer as n from public.student_practice_unlocks
         where student_id = $1 and task_type = 'build_sentence'
           and item_id in ($2, $3)`,
        [STUDENT3, ITEM_BAS3, ITEM_BAS4]
      )).rows[0].n,
      1
    );
  } finally {
    await db.close();
  }
});

test("writing draft insert charges public items, skips custom assignments and allows free retakes", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, true);
    await claim(db, STUDENT);

    const firstAttempt = await insertWritingAttempt(db, {
      userId: STUDENT,
      taskType: "email",
      questionId: "email-q1"
    });
    assert.equal(await remaining(db, STUDENT, "email"), 4);
    assert.equal(await unlockCount(db, STUDENT, "email", ITEM_EMAIL1), 1);

    await db.query(
      "update public.writing_attempts set status = 'submitted', submitted_at = now() where attempt_id = $1",
      [firstAttempt]
    );
    await insertWritingAttempt(db, {
      userId: STUDENT,
      taskType: "email",
      questionId: "email-q1"
    });
    assert.equal(await remaining(db, STUDENT, "email"), 4);

    await insertWritingAttempt(db, {
      userId: STUDENT,
      taskType: "email",
      questionId: "email-q2"
    });
    assert.equal(await remaining(db, STUDENT, "email"), 3);

    await claim(db, STUDENT2);
    await insertWritingAttempt(db, {
      userId: STUDENT2,
      taskType: "email",
      questionId: "email-q1",
      assignmentId: EMAIL_ASSIGNMENT
    });
    assert.equal(await remaining(db, STUDENT2, "email"), 5);
    assert.equal(await unlockCount(db, STUDENT2, "email", ITEM_EMAIL1), 1);

    await claim(db, STUDENT3);
    await insertWritingAttempt(db, {
      userId: STUDENT3,
      taskType: "email",
      questionId: "custom-email-q1",
      assignmentId: EMAIL_CUSTOM
    });
    assert.equal(await remaining(db, STUDENT3, "email"), 5);
    assert.equal(
      (await db.query(
        "select count(*)::integer as n from public.student_practice_unlocks where student_id = $1",
        [STUDENT3]
      )).rows[0].n,
      0
    );

    await claim(db, TEACHER);
    await insertWritingAttempt(db, {
      userId: TEACHER,
      taskType: "email",
      questionId: "email-q2"
    });
    assert.equal(
      (await db.query(
        "select count(*)::integer as n from public.student_practice_entitlements where student_id = $1",
        [TEACHER]
      )).rows[0].n,
      0
    );
    assert.equal(await unlockCount(db, TEACHER, "email", ITEM_EMAIL2), 0);

    await claim(db, STUDENT);
    await assert.rejects(
      insertWritingAttempt(db, {
        userId: STUDENT2,
        taskType: "email",
        questionId: "email-q3"
      }),
      /WRITING_ATTEMPT_ACTOR_MISMATCH/
    );
    await assert.rejects(
      db.query(
        "update public.writing_attempts set question_id = 'email-q2' where attempt_id = $1",
        [firstAttempt]
      ),
      /WRITING_ATTEMPT_IDENTITY_IMMUTABLE/
    );

    await claim(db, STUDENT4);
    await db.query(
      `insert into public.student_practice_entitlements(student_id, entitlement_kind, remaining)
       values ($1, 'email', 0)`,
      [STUDENT4]
    );
    await assert.rejects(
      insertWritingAttempt(db, {
        userId: STUDENT4,
        taskType: "email",
        questionId: "email-q3"
      }),
      /PRACTICE_ENTITLEMENT_EXHAUSTED/
    );
    assert.equal(await unlockCount(db, STUDENT4, "email", ITEM_EMAIL3), 0);

    await setFlag(db, false);
    const historicalDraft = await insertWritingAttempt(db, {
      userId: STUDENT4,
      taskType: "email",
      questionId: "email-q1"
    });
    await setFlag(db, true);
    await claim(db, STUDENT4);
    const ensured = (await db.query(
      "select public.student_ensure_writing_practice_unlock($1) as result",
      [historicalDraft]
    )).rows[0].result;
    assert.equal(ensured.ensured, true);
    assert.equal(await remaining(db, STUDENT4, "email"), 0);
    assert.equal(await unlockCount(db, STUDENT4, "email", ITEM_EMAIL1), 1);
  } finally {
    await db.close();
  }
});

test("attempts and answer rows cannot bypass BAS authorization or set identity", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, true);
    await claim(db, STUDENT);

    await assert.rejects(
      insertAttempt(db, STUDENT, SET_A),
      /PRACTICE_ENTITLEMENT_NOT_UNLOCKED/
    );
    await assert.rejects(
      db.query(
        "select public.student_assert_bas_submission_authorized($1, $2)",
        [SET_A, ["q1"]]
      ),
      /PRACTICE_ENTITLEMENT_NOT_UNLOCKED/
    );
    await basStart(db, SET_A);
    await db.query(
      "select public.student_assert_bas_submission_authorized($1, $2)",
      [SET_A, ["q1", "q2"]]
    );
    await assert.rejects(
      db.query(
        "select public.student_assert_bas_submission_authorized($1, $2)",
        [SET_A, ["q3"]]
      ),
      /PRACTICE_QUESTION_NOT_IN_SET/
    );
    const attemptId = await insertAttempt(db, STUDENT, SET_A);
    await insertAnswer(db, attemptId, STUDENT, "q1", SET_A);
    await insertAnswer(db, attemptId, STUDENT, "q2", SET_A);

    await assert.rejects(
      insertAnswer(db, attemptId, STUDENT, "q3", SET_A),
      /PRACTICE_QUESTION_NOT_IN_SET/
    );
    await assert.rejects(
      insertAnswer(db, attemptId, STUDENT, "q1", SET_C),
      /ATTEMPT_ANSWER_SET_MISMATCH/
    );
    await assert.rejects(
      db.query("update public.attempts set set_id = $2 where attempt_id = $1", [attemptId, SET_C]),
      /ATTEMPT_IDENTITY_IMMUTABLE/
    );

    await claim(db, STUDENT2);
    const virtualAttempt = await insertAttempt(db, STUDENT2, "grammar-all-1");
    await insertAnswer(db, virtualAttempt, STUDENT2, "q1", "grammar-all-1");
    assert.equal(
      (await db.query("select count(*)::integer as n from public.attempt_answers where attempt_id = $1", [virtualAttempt])).rows[0].n,
      1
    );

    await assert.rejects(
      insertAttempt(db, STUDENT, SET_C),
      /ATTEMPT_ACTOR_MISMATCH/
    );

    await claim(db, TEACHER);
    await insertAttempt(db, TEACHER, SET_C);
    assert.equal(
      (await db.query("select count(*)::integer as n from public.attempts where student_id = $1", [TEACHER])).rows[0].n,
      1
    );
  } finally {
    await db.close();
  }
});

test("reading RPCs charge first starts, reuse drafts/retakes for free and validate assignments", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, true);
    await claim(db, STUDENT);

    const first = await readingStart(db, CTW);
    assert.equal(first.created, true);
    assert.equal(await remaining(db, STUDENT, "ctw"), 4);
    assert.equal(await unlockCount(db, STUDENT, "ctw", CTW), 1);

    const resumed = await readingStart(db, CTW);
    assert.equal(resumed.created, false);
    assert.equal(resumed.resumed, true);
    assert.equal(await remaining(db, STUDENT, "ctw"), 4);

    await db.query(
      "update public.reading_attempts set status = 'submitted', submitted_at = now() where attempt_id = $1",
      [first.attemptId]
    );
    const retake = await readingRetake(db, first.attemptId);
    assert.equal(retake.created, true);
    assert.equal(await remaining(db, STUDENT, "ctw"), 4);

    await db.query(
      "update public.student_practice_entitlements set remaining = 0 where student_id = $1 and entitlement_kind = 'ctw'",
      [STUDENT]
    );
    await assert.rejects(readingStart(db, CTW2), /PRACTICE_ENTITLEMENT_EXHAUSTED/);
    assert.equal(await unlockCount(db, STUDENT, "ctw", CTW2), 0);
    const resumedAfterRetake = await readingStart(db, CTW);
    assert.equal(resumedAfterRetake.resumed, true);
    assert.equal(await remaining(db, STUDENT, "ctw"), 0);

    await claim(db, STUDENT2);
    await assert.rejects(
      readingStart(db, RDL, READING_WITHDRAWN),
      /PRACTICE_ASSIGNMENT_NOT_AVAILABLE/
    );
    assert.equal(await remaining(db, STUDENT2, "rdl"), 5);
    assert.equal(await unlockCount(db, STUDENT2, "rdl", RDL), 0);

    const assignment = await readingStart(db, CTW, READING_ASSIGNMENT);
    assert.equal(assignment.created, true);
    assert.equal(await remaining(db, STUDENT2, "ctw"), 5);
    assert.equal(await unlockCount(db, STUDENT2, "ctw", CTW), 1);

    await db.query(
      "update public.writing_assignments set status = 'withdrawn' where assignment_id = $1",
      [READING_ASSIGNMENT]
    );
    const resumedAfterWithdrawal = await readingStart(db, CTW, READING_ASSIGNMENT);
    assert.equal(resumedAfterWithdrawal.resumed, true);
    assert.equal(await remaining(db, STUDENT2, "ctw"), 5);

    await claim(db, TEACHER);
    const teacherReading = await readingStart(db, RAP);
    assert.equal(teacherReading.created, true);
    assert.equal(
      (await db.query(
        "select count(*)::integer as n from public.student_practice_entitlements where student_id = $1",
        [TEACHER]
      )).rows[0].n,
      0
    );
    assert.equal(await unlockCount(db, TEACHER, "rap", RAP), 0);

    await claim(db, STUDENT3);
    const oldWrapper = (await db.query(
      "select public.get_or_create_reading_attempt($1) as attempt",
      [RAP2]
    )).rows[0].attempt;
    assert.equal(oldWrapper.created, true);
    assert.equal(await remaining(db, STUDENT3, "rap"), 4);
    assert.equal(await unlockCount(db, STUDENT3, "rap", RAP2), 1);

    await claim(db, STUDENT4);
    const concurrentReading = await Promise.allSettled([
      readingStart(db, RDL),
      readingStart(db, RDL)
    ]);
    assert.equal(
      concurrentReading.filter((entry) => entry.status === "fulfilled").length,
      2
    );
    assert.equal(
      concurrentReading.filter((entry) =>
        entry.status === "fulfilled" && entry.value.created
      ).length,
      1
    );
    assert.equal(await remaining(db, STUDENT4, "rdl"), 4);
    assert.equal(await unlockCount(db, STUDENT4, "rdl", RDL), 1);
  } finally {
    await db.close();
  }
});

manualSqlTest("historical backfill inserts only missing unlocks, excludes custom/category rows and is idempotent", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, false);
    await insertAttempt(db, STUDENT, SET_A);
    await insertAttempt(db, STUDENT2, SET_B);
    await insertAttempt(db, STUDENT, "grammar-all-1");
    await insertAttempt(db, STUDENT2, "wrongbook-set-1");

    await insertWritingAttempt(db, {
      userId: STUDENT,
      taskType: "email",
      questionId: "email-q1"
    });
    await insertWritingAttempt(db, {
      userId: STUDENT2,
      taskType: "email",
      questionId: "email-q1",
      status: "submitted"
    });
    await insertWritingAttempt(db, {
      userId: STUDENT3,
      taskType: "email",
      questionId: "custom-email-q1",
      assignmentId: EMAIL_CUSTOM
    });
    await insertWritingAttempt(db, {
      userId: STUDENT4,
      taskType: "email",
      questionId: "email-q2",
      attemptKind: "correction"
    });

    await claim(db, STUDENT);
    const ctwAttempt = await readingStart(db, CTW);
    await db.query(
      "update public.reading_attempts set status = 'submitted', submitted_at = now() where attempt_id = $1",
      [ctwAttempt.attemptId]
    );
    await claim(db, STUDENT2);
    const rdlAttempt = await readingStart(db, RDL);
    await db.query(
      "update public.reading_attempts set status = 'submitted', submitted_at = now() where attempt_id = $1",
      [rdlAttempt.attemptId]
    );

    const beforeEntitlements = (await db.query(
      "select count(*)::integer as n from public.student_practice_entitlements"
    )).rows[0].n;
    const beforeEvents = (await db.query(
      "select count(*)::integer as n from public.student_practice_entitlement_events"
    )).rows[0].n;

    await db.exec(BACKFILL_DRY);
    await db.exec(BACKFILL_APPLY);

    const unlocks = (await db.query(
      `select task_type, count(*)::integer as n
       from public.student_practice_unlocks
       group by task_type order by task_type`
    )).rows;
    assert.deepEqual(unlocks, [
      { task_type: "build_sentence", n: 2 },
      { task_type: "ctw", n: 1 },
      { task_type: "email", n: 2 },
      { task_type: "rdl", n: 1 }
    ]);
    assert.equal(
      (await db.query(
        "select count(*)::integer as n from public.student_practice_unlocks where item_id = $1",
        ["custom-email-q1"]
      )).rows[0].n,
      0
    );
    assert.equal(
      (await db.query(
        "select count(*)::integer as n from public.student_practice_unlocks where lower(item_id) like 'grammar-%' or lower(item_id) like 'wrongbook-%'"
      )).rows[0].n,
      0
    );
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
    await db.exec(BACKFILL_APPLY);
    assert.equal(
      (await db.query(
        "select count(*)::integer as n from public.student_practice_unlocks"
      )).rows[0].n,
      beforeRerun
    );
    await db.exec(BACKFILL_VERIFY);
  } finally {
    await db.close();
  }
});
