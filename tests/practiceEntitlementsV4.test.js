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
const PHASE4 = read("supabase/student_practice_entitlements_v4_20261115.sql");

const MANUAL_SQL_DIR = process.env.TPS_MANUAL_SQL_DIR?.trim() ?? "";
const readManual = (file) => {
  if (!MANUAL_SQL_DIR) return null;
  try {
    return fs.readFileSync(path.join(MANUAL_SQL_DIR, file), "utf8");
  } catch {
    return null;
  }
};
const PHASE4_PREFLIGHT = readManual("preflight_phase4.sql");
const PHASE4_VERIFY = readManual("verify_phase4.sql");
const PHASE4_DUPLICATES = readManual("inspect_phase4_duplicate_category_sessions.sql");
const phase4SqlAvailable = Boolean(PHASE4_PREFLIGHT && PHASE4_VERIFY && PHASE4_DUPLICATES);
const phase4SqlTest = (name, fn) => test(name, {
  skip: phase4SqlAvailable ? false : "Set TPS_MANUAL_SQL_DIR to the local manual SQL directory"
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

const GRAMMAR_TAG = "时态";
const GRAMMAR_OTHER_TAG = "从句";
const RAP_CATEGORY = "事实信息题";
const GRAMMAR_QUESTION_IDS = Array.from(
  { length: 12 },
  (_, index) => `grammar-q-${String(index + 1).padStart(2, "0")}`
);
const REQUEST_BAS_1 = "a0000000-0000-4000-8000-000000000001";
const REQUEST_BAS_2 = "a0000000-0000-4000-8000-000000000002";
const REQUEST_BAS_3 = "a0000000-0000-4000-8000-000000000003";
const REQUEST_BAS_4 = "a0000000-0000-4000-8000-000000000004";
const REQUEST_RAP_1 = "b0000000-0000-4000-8000-000000000001";
const REQUEST_RAP_2 = "b0000000-0000-4000-8000-000000000002";
const REQUEST_RAP_3 = "b0000000-0000-4000-8000-000000000003";
const REQUEST_RAP_4 = "b0000000-0000-4000-8000-000000000004";

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
    full_name text,
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

  create table public.reading_question_category_sessions (
    session_id uuid primary key default gen_random_uuid(),
    student_id uuid not null,
    question_category text not null,
    amount integer not null,
    manifest jsonb not null,
    progress jsonb not null default '{}'::jsonb,
    draft jsonb not null default '{}'::jsonb,
    status text not null default 'active',
    elapsed_seconds integer not null default 0,
    total_points integer not null default 0,
    correct_points integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    completed_at timestamptz
  );
  create or replace function public.reading_category_session_json(
    p_session public.reading_question_category_sessions
  ) returns jsonb language sql stable set search_path = '' as $$
    select jsonb_build_object(
      'sessionId', p_session.session_id,
      'questionCategory', p_session.question_category,
      'amount', p_session.amount,
      'groups', p_session.manifest -> 'groups',
      'progress', p_session.progress,
      'draft', p_session.draft,
      'status', p_session.status,
      'elapsedSeconds', p_session.elapsed_seconds,
      'totalPoints', p_session.total_points,
      'correctPoints', p_session.correct_points,
      'createdAt', p_session.created_at,
      'completedAt', p_session.completed_at
    );
  $$;
  create or replace function public.reading_category_answers_json(
    p_session_id uuid,
    p_item_id text default null
  ) returns jsonb language sql stable set search_path = '' as $$
    select '[]'::jsonb;
  $$;
  create or replace function public.guard_reading_category_manifest()
  returns trigger language plpgsql set search_path = '' as $$
  begin
    return new;
  end;
  $$;
  create trigger reading_category_manifest_guard
    before insert or update on public.reading_question_category_sessions
    for each row execute function public.guard_reading_category_manifest();
  create or replace function public.touch_reading_category()
  returns trigger language plpgsql set search_path = '' as $$
  begin
    return new;
  end;
  $$;
  create trigger reading_category_updated_at
    before update on public.reading_question_category_sessions
    for each row execute function public.touch_reading_category();

  create table public.questions (
    question_id text primary key,
    set_id text,
    set_title text,
    question_order integer not null default 0,
    prompt text not null default '',
    sentence_template text not null default '',
    blank_count integer not null default 1,
    options_text text not null default '',
    distractors_text text not null default '',
    final_sentence text,
    grammar_tags_text text
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

  insert into public.questions(
    question_id, set_id, set_title, question_order, prompt,
    sentence_template, blank_count, options_text, distractors_text,
    final_sentence, grammar_tags_text
  )
  select
    'grammar-q-' || lpad(series::text, 2, '0'),
    'grammar-set',
    'Grammar fixture',
    series,
    'Prompt ' || series,
    '[blank]',
    1,
    'a|b|c',
    '',
    'Sentence ' || series,
    case when series = 12
      then '["${GRAMMAR_OTHER_TAG}"]'
      else '["${GRAMMAR_TAG}"]'
    end
  from generate_series(1, 12) series;

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

async function freshDb({ withPhase4 = true } = {}) {
  const db = new PGlite();
  await db.exec(FIXTURE);
  await db.exec(PHASE1);
  await db.exec(PHASE2);
  await db.exec(PHASE3);
  if (withPhase4) await db.exec(PHASE4);
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

function basManifest(tag = GRAMMAR_TAG, questionIds = GRAMMAR_QUESTION_IDS.slice(0, 10)) {
  return {
    kind: "bas_grammar",
    version: 1,
    category: tag,
    questions: questionIds.map((questionId, index) => ({
      question_id: questionId,
      set_id: "grammar-set",
      set_title: "Grammar fixture",
      question_order: index + 1,
      prompt: `Prompt ${index + 1}`,
      sentence_template: "[blank]",
      blank_count: 1,
      options_text: "a|b|c",
      distractors_text: ""
    }))
  };
}

function rapManifest(category = RAP_CATEGORY) {
  return {
    kind: "question_category",
    version: 1,
    category,
    groups: [
      {
        logicalItemId: RAP,
        title: "RAP fixture",
        targets: [{ questionId: "rap-q-1", slotId: null }]
      }
    ]
  };
}

async function startBas(db, studentId, tag, requestId, manifest = basManifest(tag)) {
  const result = await db.query(
    `select public.start_bas_grammar_practice_session(
       $1::uuid, $2::text, $3::jsonb, $4::uuid
     ) as payload`,
    [studentId, tag, JSON.stringify(manifest), requestId]
  );
  return result.rows[0].payload;
}

async function startRap(db, studentId, category, requestId, amount = 5) {
  const result = await db.query(
    `select public.start_reading_question_category_practice(
       $1::uuid, $2::text, $3::integer, $4::jsonb, $5::uuid
     ) as payload`,
    [studentId, category, amount, JSON.stringify(rapManifest(category)), requestId]
  );
  return result.rows[0].payload;
}

async function getBas(db, studentId, sessionId) {
  await claim(db, studentId);
  const result = await db.query(
    "select public.get_bas_grammar_practice_session($1::uuid) as payload",
    [sessionId]
  );
  return result.rows[0].payload;
}

async function setRemaining(db, studentId, kind, value) {
  await db.query(
    `insert into public.student_practice_entitlements(
       student_id, entitlement_kind, remaining, updated_at, updated_by
     ) values ($1, $2, $3, clock_timestamp(), $1)
     on conflict (student_id, entitlement_kind) do update
     set remaining = excluded.remaining, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    [studentId, kind, value]
  );
}

async function createAttemptForBasSession(db, studentId, sessionId, questionIds, correctCount = 7) {
  const attempt = (await db.query(
    `insert into public.attempts(
       student_id, set_id, set_title, correct_count, total_questions,
       time_spent_seconds, submitted_at
     ) values ($1, $2, 'Grammar fixture', $3, $4, 120, clock_timestamp())
     returning attempt_id`,
    [studentId, `grammar-random-${sessionId}`, correctCount, questionIds.length]
  )).rows[0];
  for (const [index, questionId] of questionIds.entries()) {
    await db.query(
      `insert into public.attempt_answers(
         attempt_id, question_id, student_id, set_id, question_order,
         prompt, submitted_order_text, correct_order_text, is_correct
       ) values ($1, $2, $3, $4, $5, '', 'a', 'a', $6)`,
      [
        attempt.attempt_id,
        questionId,
        studentId,
        `grammar-random-${sessionId}`,
        index + 1,
        index < correctCount
      ]
    );
  }
  return attempt.attempt_id;
}

test("v4 migration is additive and does not enable enforcement or write ordinary unlocks", () => {
  assert.equal((PHASE4.match(/^begin;/gm) ?? []).length, 1);
  assert.equal((PHASE4.match(/^commit;/gm) ?? []).length, 1);
  assert.equal((PHASE4.match(/\$\$/g) ?? []).length % 2, 0);

  assert.match(PHASE4, /practice_entitlement_spend_category/);
  assert.match(PHASE4, /start_bas_grammar_practice_session/);
  assert.match(PHASE4, /start_reading_question_category_practice/);
  assert.match(PHASE4, /bas_grammar_practice_sessions/);
  assert.match(PHASE4, /reading_category_student_request_uidx/);
  assert.match(PHASE4, /BAS_GRAMMAR_INVALID_MANIFEST/);
  assert.match(PHASE4, /PRACTICE_ENTITLEMENT_CATEGORY_EXHAUSTED/);
  assert.match(PHASE4, /service_role/);
  assert.doesNotMatch(PHASE4, /insert\s+into\s+public\.student_practice_unlocks/i);
  assert.doesNotMatch(PHASE4, /update\s+public\.practice_entitlement_runtime_config/i);
  assert.doesNotMatch(PHASE4, /enforcement_enabled\s*=\s*true/i);
  assert.doesNotMatch(PHASE4, /delete\s+from\s+public\.reading_question_category_sessions/i);
});

test("switch OFF creates category sessions without spending and without unlocks", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, false);
    await claim(db, STUDENT);

    const bas = await startBas(db, STUDENT, GRAMMAR_TAG, REQUEST_BAS_1);
    const rap = await startRap(db, STUDENT, RAP_CATEGORY, REQUEST_RAP_1);

    assert.equal(bas.created, true);
    assert.equal(rap.created, true);
    assert.equal(await remaining(db, STUDENT, "bas_category"), 3);
    assert.equal(await remaining(db, STUDENT, "rap_category"), 3);
    assert.equal(await unlockTotal(db, STUDENT), 0);

    const row = (await db.query(
      "select origin, start_request_id, status from public.reading_question_category_sessions where session_id = $1",
      [rap.session.sessionId]
    )).rows[0];
    assert.equal(row.origin, "self_practice");
    assert.equal(row.start_request_id, REQUEST_RAP_1);
    assert.equal(row.status, "active");
  } finally {
    await db.close();
  }
});

test("BAS Grammar spends three sessions, shares across categories, is idempotent and never unlocks", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, true);
    await claim(db, STUDENT);

    const first = await startBas(db, STUDENT, GRAMMAR_TAG, REQUEST_BAS_1);
    assert.equal(first.created, true);
    assert.equal(await remaining(db, STUDENT, "bas_category"), 2);

    const second = await startBas(db, STUDENT, GRAMMAR_OTHER_TAG, REQUEST_BAS_2, basManifest(GRAMMAR_OTHER_TAG, ["grammar-q-12"]));
    assert.equal(second.created, true);
    assert.equal(await remaining(db, STUDENT, "bas_category"), 1);

    const third = await startBas(db, STUDENT, GRAMMAR_TAG, REQUEST_BAS_3);
    assert.equal(third.created, true);
    assert.equal(await remaining(db, STUDENT, "bas_category"), 0);

    await assert.rejects(
      startBas(db, STUDENT, GRAMMAR_TAG, REQUEST_BAS_4),
      /PRACTICE_ENTITLEMENT_CATEGORY_EXHAUSTED/
    );

    // The same Start intent retry returns the same frozen session without spend.
    const retry = await startBas(db, STUDENT, GRAMMAR_TAG, REQUEST_BAS_1);
    assert.equal(retry.created, false);
    assert.equal(retry.session.sessionId, first.session.sessionId);
    assert.deepEqual(retry.session.questions, first.session.questions);
    assert.equal(await remaining(db, STUDENT, "bas_category"), 0);

    await assert.rejects(
      startBas(db, STUDENT, GRAMMAR_OTHER_TAG, REQUEST_BAS_1),
      /BAS_GRAMMAR_REQUEST_ID_CONFLICT/
    );

    // A zero quota still permits owner resume.
    const resumed = await getBas(db, STUDENT, first.session.sessionId);
    assert.equal(resumed.session.sessionId, first.session.sessionId);
    assert.equal(resumed.session.status, "active");

    // Teacher/Admin autonomous testing never spends.
    const teacher = await startBas(db, TEACHER, GRAMMAR_TAG, REQUEST_BAS_3.replace("a000", "c000"));
    assert.equal(teacher.created, true);
    assert.equal(await remaining(db, TEACHER, "bas_category"), 3);

    assert.equal(await remaining(db, STUDENT, "build_sentence"), 5);
    assert.equal(await remaining(db, STUDENT, "rap"), 5);
    assert.equal(await unlockTotal(db, STUDENT), 0);
    const kinds = (await db.query(
      "select entitlement_kind from public.student_practice_entitlements where student_id = $1 order by entitlement_kind",
      [STUDENT]
    )).rows.map((row) => row.entitlement_kind);
    assert.deepEqual(kinds, ["bas_category"]);
    const events = await eventRows(db, STUDENT);
    assert.equal(events.filter((event) => event.operation === "spend").length, 3);
    assert.ok(events.every((event) => event.request_id));
  } finally {
    await db.close();
  }
});

test("BAS draft restores answers and the frozen manifest, then completion links the attempt", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, true);
    await claim(db, STUDENT);
    const started = await startBas(db, STUDENT, GRAMMAR_TAG, REQUEST_BAS_1);
    const sessionId = started.session.sessionId;
    const questionIds = started.session.questions.map((question) => question.question_id);

    const draft = {
      answers: {
        [questionIds[0]]: ["a"],
        [questionIds[1]]: ["a"]
      },
      questionTimes: {
        [questionIds[0]]: 12,
        [questionIds[1]]: 9
      },
      currentIndex: 2,
      elapsedSeconds: 31,
      revision: 1
    };
    await db.query(
      "select public.save_bas_grammar_practice_draft($1::uuid, $2::jsonb)",
      [sessionId, JSON.stringify(draft)]
    );

    const resumed = await getBas(db, STUDENT, sessionId);
    assert.equal(resumed.session.draft.currentIndex, 2);
    assert.equal(resumed.session.draft.revision, 1);
    assert.deepEqual(resumed.session.draft.answers[questionIds[0]], ["a"]);

    // The manifest is a snapshot: a later source edit cannot change resume.
    await db.query(
      "update public.questions set prompt = 'changed after start' where question_id = $1",
      [questionIds[0]]
    );
    const frozen = await getBas(db, STUDENT, sessionId);
    assert.equal(frozen.session.questions[0].prompt, "Prompt 1");
    assert.equal(await remaining(db, STUDENT, "bas_category"), 2);

    const attemptId = await createAttemptForBasSession(db, STUDENT, sessionId, questionIds, 7);
    const completed = (await db.query(
      `select public.complete_bas_grammar_practice_session(
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6
       ) as payload`,
      [STUDENT, sessionId, attemptId, 7, questionIds.length, 120]
    )).rows[0].payload;
    assert.equal(completed.status, "completed");
    assert.equal(completed.correctCount, 7);
    assert.equal(completed.attemptId, attemptId);
    assert.deepEqual(completed.draft, {});

    const row = (await db.query(
      "select status, attempt_id, correct_count, total_questions, completed_at from public.bas_grammar_practice_sessions where session_id = $1",
      [sessionId]
    )).rows[0];
    assert.equal(row.status, "completed");
    assert.equal(row.attempt_id, attemptId);
    assert.equal(row.correct_count, 7);
    assert.equal(row.total_questions, questionIds.length);
    assert.ok(row.completed_at);

    // Same-attempt completion retry is idempotent; a different attempt is not.
    await db.query(
      `select public.complete_bas_grammar_practice_session($1::uuid,$2::uuid,$3::uuid,$4,$5,$6)`,
      [STUDENT, sessionId, attemptId, 7, questionIds.length, 120]
    );
    await assert.rejects(
      db.query(
        `select public.complete_bas_grammar_practice_session($1::uuid,$2::uuid,$3::uuid,$4,$5,$6)`,
        [STUDENT, sessionId, genRandomUuid(), 7, questionIds.length, 120]
      ),
      /BAS_GRAMMAR_SESSION_COMPLETED/
    );
  } finally {
    await db.close();
  }
});

test("RAP Category shares one three-session quota and retries the same request id", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, true);
    await claim(db, STUDENT);

    const first = await startRap(db, STUDENT, "事实信息题", REQUEST_RAP_1);
    assert.equal(first.created, true);
    assert.equal(await remaining(db, STUDENT, "rap_category"), 2);
    assert.equal(await remaining(db, STUDENT, "bas_category"), 3);

    const second = await startRap(db, STUDENT, "否定信息题", REQUEST_RAP_2);
    assert.equal(second.created, true);
    assert.equal(await remaining(db, STUDENT, "rap_category"), 1);

    const third = await startRap(db, STUDENT, "主旨题", REQUEST_RAP_3);
    assert.equal(third.created, true);
    assert.equal(await remaining(db, STUDENT, "rap_category"), 0);

    await assert.rejects(
      startRap(db, STUDENT, "词汇题", REQUEST_RAP_4),
      /PRACTICE_ENTITLEMENT_CATEGORY_EXHAUSTED/
    );

    const retry = await startRap(db, STUDENT, "事实信息题", REQUEST_RAP_1);
    assert.equal(retry.created, false);
    assert.equal(retry.session.sessionId, first.session.sessionId);
    assert.equal(await remaining(db, STUDENT, "rap_category"), 0);

    await assert.rejects(
      startRap(db, STUDENT, "否定信息题", REQUEST_RAP_1),
      /CATEGORY_REQUEST_ID_CONFLICT/
    );

    const teacher = await startRap(db, TEACHER, "事实信息题", REQUEST_RAP_4.replace("b000", "d000"));
    assert.equal(teacher.created, true);
    assert.equal(await remaining(db, TEACHER, "rap_category"), 3);

    assert.equal(await unlockTotal(db, STUDENT), 0);
    assert.equal(await remaining(db, STUDENT, "bas_category"), 3);
    assert.equal(await remaining(db, STUDENT, "rap"), 5);
  } finally {
    await db.close();
  }
});

test("zero quota blocks new category sessions but keeps an existing BAS session resumable", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, true);
    await claim(db, STUDENT);
    const started = await startBas(db, STUDENT, GRAMMAR_TAG, REQUEST_BAS_1);
    await setRemaining(db, STUDENT, "bas_category", 0);

    await assert.rejects(
      startBas(db, STUDENT, GRAMMAR_TAG, REQUEST_BAS_2),
      /PRACTICE_ENTITLEMENT_CATEGORY_EXHAUSTED/
    );
    const resumed = await getBas(db, STUDENT, started.session.sessionId);
    assert.equal(resumed.session.sessionId, started.session.sessionId);
    assert.equal(await remaining(db, STUDENT, "bas_category"), 0);
  } finally {
    await db.close();
  }
});

test("v4 preserves historical duplicate active RAP sessions and backfills their origin", async () => {
  const db = await freshDb({ withPhase4: false });
  try {
    const manifest = JSON.stringify(rapManifest());
    const older = (await db.query(
      `insert into public.reading_question_category_sessions(
         student_id, question_category, amount, manifest, status, created_at
       ) values ($1, $2, 5, $3::jsonb, 'active', now() - interval '2 days')
       returning session_id`,
      [STUDENT, RAP_CATEGORY, manifest]
    )).rows[0].session_id;
    const newer = (await db.query(
      `insert into public.reading_question_category_sessions(
         student_id, question_category, amount, manifest, status, created_at, draft
       ) values ($1, $2, 5, $3::jsonb, 'active', now(), $4::jsonb)
       returning session_id`,
      [
        STUDENT,
        RAP_CATEGORY,
        manifest,
        JSON.stringify({ logicalItemId: RAP, workspace: { currentIndex: 0, elapsedSeconds: 20, revision: 1 } })
      ]
    )).rows[0].session_id;

    await db.exec(PHASE4);

    const rows = (await db.query(
      `select session_id, origin, start_request_id, status
       from public.reading_question_category_sessions
       where student_id = $1 and question_category = $2
       order by created_at`,
      [STUDENT, RAP_CATEGORY]
    )).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.session_id), [older, newer]);
    assert.ok(rows.every((row) => row.origin === "self_practice"));
    assert.ok(rows.every((row) => row.start_request_id === null));
    assert.ok(rows.every((row) => row.status === "active"));
    assert.equal(
      (await db.query(
        "select count(*)::integer as n from public.reading_question_category_sessions where session_id = any($1::uuid[])",
        [[older, newer]]
      )).rows[0].n,
      2
    );
  } finally {
    await db.close();
  }
});

test("v4 migration is re-runnable and preserves existing category sessions and quota", async () => {
  const db = await freshDb();
  try {
    await setFlag(db, true);
    await claim(db, STUDENT);
    const bas = await startBas(db, STUDENT, GRAMMAR_TAG, REQUEST_BAS_1);
    const rap = await startRap(db, STUDENT, RAP_CATEGORY, REQUEST_RAP_1);

    await db.exec(PHASE4);

    assert.equal(await remaining(db, STUDENT, "bas_category"), 2);
    assert.equal(await remaining(db, STUDENT, "rap_category"), 2);
    const basResume = await getBas(db, STUDENT, bas.session.sessionId);
    assert.equal(basResume.session.sessionId, bas.session.sessionId);
    assert.equal(
      (await db.query(
        "select count(*)::integer as n from public.reading_question_category_sessions where session_id = $1",
        [rap.session.sessionId]
      )).rows[0].n,
      1
    );

    const retry = await startBas(db, STUDENT, GRAMMAR_TAG, REQUEST_BAS_1);
    assert.equal(retry.created, false);
    assert.equal(await remaining(db, STUDENT, "bas_category"), 2);
  } finally {
    await db.close();
  }
});

test("v4 keeps the feature switch OFF and revokes direct client session writes", async () => {
  const db = await freshDb();
  try {
    const flag = (await db.query(
      "select enforcement_enabled from public.practice_entitlement_runtime_config where singleton = true"
    )).rows[0];
    assert.equal(flag.enforcement_enabled, false);

    const tablePrivilege = (await db.query(
      "select has_table_privilege('authenticated', 'public.bas_grammar_practice_sessions', 'INSERT') as allowed"
    )).rows[0].allowed;
    assert.equal(tablePrivilege, false);

    const functionPrivilege = (await db.query(
      `select has_function_privilege(
         'authenticated',
         'public.start_bas_grammar_practice_session(uuid,text,jsonb,uuid,text,uuid)',
         'EXECUTE'
       ) as allowed`
    )).rows[0].allowed;
    assert.equal(functionPrivilege, false);

    const rapFunctionPrivilege = (await db.query(
      `select has_function_privilege(
         'authenticated',
         'public.start_reading_question_category_practice(uuid,text,integer,jsonb,uuid,text,uuid)',
         'EXECUTE'
       ) as allowed`
    )).rows[0].allowed;
    assert.equal(rapFunctionPrivilege, false);

    const servicePrivilege = (await db.query(
      `select has_function_privilege(
         'service_role',
         'public.start_bas_grammar_practice_session(uuid,text,jsonb,uuid,text,uuid)',
         'EXECUTE'
       ) as allowed`
    )).rows[0].allowed;
    assert.equal(servicePrivilege, true);

    const rls = (await db.query(
      "select relrowsecurity from pg_class where oid = 'public.bas_grammar_practice_sessions'::regclass"
    )).rows[0].relrowsecurity;
    assert.equal(rls, true);
  } finally {
    await db.close();
  }
});

test("Student all-mode policy is server-side while Teacher/Admin and switch OFF stay compatible", () => {
  const {
    grammarPracticeModePolicy,
    normalizeGrammarPracticeMode
  } = require("../lib/grammarPractice.ts");

  assert.equal(normalizeGrammarPracticeMode(undefined), "all");
  assert.equal(normalizeGrammarPracticeMode("random"), "random");
  assert.equal(normalizeGrammarPracticeMode("unexpected"), "all");

  assert.equal(
    grammarPracticeModePolicy({
      role: "student",
      enforcementEnabled: true,
      mode: "all"
    }).allowed,
    false
  );
  assert.equal(
    grammarPracticeModePolicy({
      role: "student",
      enforcementEnabled: true,
      mode: "random"
    }).allowed,
    true
  );
  assert.equal(
    grammarPracticeModePolicy({
      role: "student",
      enforcementEnabled: false,
      mode: "all"
    }).allowed,
    true
  );
  assert.equal(
    grammarPracticeModePolicy({
      role: "teacher",
      enforcementEnabled: true,
      mode: "all"
    }).allowed,
    true
  );
  assert.equal(
    grammarPracticeModePolicy({
      role: "admin",
      enforcementEnabled: true,
      mode: "all"
    }).allowed,
    true
  );
});

test("phase 4 API and UI wiring uses the frozen session and 410-second random timer", () => {
  const grammarUi = read("components/GrammarPractice.tsx");
  const grammarLib = read("lib/grammarPractice.ts");
  const grammarRoute = read("app/api/grammar-practice/route.ts");
  const grammarSessionRoute = read("app/api/grammar-practice/sessions/route.ts");
  const submitRoute = read("app/api/submissions/route.ts");
  const categoryServer = read("lib/reading/questionCategory.server.ts");
  const categoryPractice = read("components/reading/QuestionCategoryPractice.tsx");

  assert.match(grammarLib, /GRAMMAR_PRACTICE_TIME_SECONDS = 6 \* 60 \+ 50/);
  assert.match(grammarUi, /GRAMMAR_RANDOM_TIME_SECONDS = GRAMMAR_PRACTICE_TIME_SECONDS/);
  assert.match(grammarUi, /grammarSessionId=\{session\.sessionId\}/);
  assert.match(grammarRoute, /grammarPracticeModePolicy/);
  assert.match(grammarRoute, /loadPracticeEntitlementEnforcementEnabled/);
  assert.match(grammarSessionRoute, /start_bas_grammar_practice_session/);
  assert.match(grammarSessionRoute, /bas_grammar/);
  assert.match(submitRoute, /grammarSessionId/);
  assert.match(submitRoute, /complete_bas_grammar_practice_session/);
  assert.match(submitRoute, /grammar-all-/);
  assert.match(categoryServer, /start_reading_question_category_practice/);
  assert.match(categoryPractice, /requestId: effectiveRequestId/);
});

phase4SqlTest("phase 4 manual SQL is read-only preflight/verify plus duplicate inspection", () => {
  assert.match(PHASE4_PREFLIGHT, /read only/i);
  assert.match(PHASE4_VERIFY, /read only/i);
  assert.match(PHASE4_DUPLICATES, /reading_question_category_sessions/);
  assert.doesNotMatch(PHASE4_PREFLIGHT, /insert\s+into|update\s+public|delete\s+from/i);
  assert.doesNotMatch(PHASE4_VERIFY, /insert\s+into|update\s+public|delete\s+from/i);
  assert.doesNotMatch(PHASE4_DUPLICATES, /insert\s+into|update\s+public|delete\s+from/i);
});

phase4SqlTest("phase 4 manual preflight, verification and duplicate inspection execute", async () => {
  const db = await freshDb({ withPhase4: false });
  try {
    await db.exec(PHASE4_PREFLIGHT);
    await db.exec(PHASE4);
    await db.exec(PHASE4_VERIFY);
    await db.exec(PHASE4_DUPLICATES);
  } finally {
    await db.close();
  }
});

function genRandomUuid() {
  return "f0000000-0000-4000-8000-" + String(Date.now()).padStart(12, "0").slice(-12);
}
