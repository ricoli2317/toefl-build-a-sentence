const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { PGlite } = require("@electric-sql/pglite");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const PHASE5 = read("supabase/student_practice_entitlements_v5_20261115.sql");
const MIXED = read("supabase/category_assignment_mixed_batch_20261115.sql");
const MANUAL_SQL_DIR = process.env.TPS_MANUAL_SQL_DIR?.trim() ?? "";
const readManual = (file) => {
  if (!MANUAL_SQL_DIR) return null;
  try {
    return fs.readFileSync(path.join(MANUAL_SQL_DIR, file), "utf8");
  } catch {
    return null;
  }
};
const PHASE5_PREFLIGHT = readManual("preflight_phase5.sql");
const PHASE5_VERIFY = readManual("verify_phase5.sql");
const PHASE5_INSPECT = readManual("inspect_phase5_category_assignments.sql");
const MIXED_PREFLIGHT = readManual("mixed_assignment_preflight.sql");
const MIXED_VERIFY = readManual("mixed_assignment_verify.sql");
const phase5SqlTest = (name, fn) => test(name, {
  skip: PHASE5_PREFLIGHT && PHASE5_VERIFY && PHASE5_INSPECT
    ? false
    : "Set TPS_MANUAL_SQL_DIR to the local manual SQL directory"
}, fn);
const mixedSqlTest = (name, fn) => test(name, {
  skip: MIXED_PREFLIGHT && MIXED_VERIFY
    ? false
    : "Set TPS_MANUAL_SQL_DIR to the local manual SQL directory"
}, fn);

const TEACHER = "10000000-0000-4000-8000-000000000001";
const STUDENT = "10000000-0000-4000-8000-000000000002";
const STUDENT2 = "10000000-0000-4000-8000-000000000003";
const CLASS = "50000000-0000-4000-8000-000000000001";
const BAS_ASSIGNMENT = "90000000-0000-4000-8000-000000000001";
const RAP_ASSIGNMENT = "90000000-0000-4000-8000-000000000002";
const REQUEST_BAS_1 = "a0000000-0000-4000-8000-000000000001";
const REQUEST_BAS_2 = "a0000000-0000-4000-8000-000000000002";
const REQUEST_RAP_1 = "b0000000-0000-4000-8000-000000000001";
const REQUEST_RAP_2 = "b0000000-0000-4000-8000-000000000002";

const BAS_CATEGORIES = ["时态", "从句", "非谓语动词"];
const BAS_QUESTIONS_BY_CATEGORY = {
  时态: Array.from({ length: 12 }, (_, index) => `bas-tense-${index + 1}`),
  从句: Array.from({ length: 12 }, (_, index) => `bas-clause-${index + 1}`),
  非谓语动词: Array.from({ length: 12 }, (_, index) => `bas-nonfinite-${index + 1}`)
};
const RAP_QUESTIONS = [
  ["rap-fact-1", "事实信息题", "logical-fact-1"],
  ["rap-fact-2", "事实信息题", "logical-fact-1"],
  ["rap-fact-3", "事实信息题", "logical-fact-2"],
  ["rap-fact-4", "事实信息题", "logical-fact-2"],
  ["rap-inf-1", "推断题", "logical-inf-1"],
  ["rap-inf-2", "推断题", "logical-inf-1"],
  ["rap-inf-3", "推断题", "logical-inf-2"],
  ["rap-inf-4", "推断题", "logical-inf-2"],
  ["rap-vocab-1", "词汇题", "logical-vocab-1"],
  ["rap-vocab-2", "词汇题", "logical-vocab-1"],
  ["rap-vocab-3", "词汇题", "logical-vocab-2"],
  ["rap-vocab-4", "词汇题", "logical-vocab-2"]
];

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
  create table public.practice_entitlement_runtime_config (
    singleton boolean primary key,
    enforcement_enabled boolean not null default false
  );
  insert into public.practice_entitlement_runtime_config(singleton, enforcement_enabled)
  values (true, false);
  create table public.student_practice_unlocks (
    student_id uuid not null,
    task_type text not null,
    item_id text not null,
    primary key (student_id, task_type, item_id)
  );
  create table public.teacher_student_bindings (
    teacher_id uuid not null references public.profiles(id) on delete cascade,
    student_id uuid not null references public.profiles(id) on delete cascade,
    domain text not null,
    primary key (teacher_id, student_id, domain)
  );
  create table public.teacher_classes (
    class_id uuid primary key default gen_random_uuid(),
    teacher_id uuid not null references public.profiles(id) on delete cascade,
    name text not null,
    subjects text[] not null default '{}',
    created_at timestamptz not null default now()
  );
  create table public.teacher_class_bindings (
    class_id uuid not null references public.teacher_classes(class_id) on delete cascade,
    teacher_id uuid not null references public.profiles(id) on delete cascade,
    subjects text[] not null default '{}',
    primary key (class_id, teacher_id)
  );
  create table public.class_members (
    class_id uuid not null references public.teacher_classes(class_id) on delete cascade,
    student_id uuid not null references public.profiles(id) on delete cascade,
    joined_at timestamptz not null default now(),
    primary key (class_id, student_id)
  );
  create function public.is_class_teacher(p_class_id uuid, p_teacher_id uuid)
  returns boolean language sql stable set search_path = '' as $$
    select exists (
      select 1 from public.teacher_classes c
      where c.class_id = p_class_id and c.teacher_id = p_teacher_id
    ) or exists (
      select 1 from public.teacher_class_bindings b
      where b.class_id = p_class_id and b.teacher_id = p_teacher_id
    );
  $$;

  create table public.writing_assignment_groups (
    group_id uuid primary key default gen_random_uuid(),
    teacher_id uuid not null references public.profiles(id) on delete cascade,
    title text,
    class_id uuid,
    created_at timestamptz not null default now()
  );
  create table public.writing_assignments (
    assignment_id uuid primary key default gen_random_uuid(),
    teacher_id uuid not null references public.profiles(id) on delete cascade,
    subject text not null default 'writing'
      constraint writing_assignments_subject_check check (subject in ('writing','reading')),
    group_id uuid references public.writing_assignment_groups(group_id) on delete set null,
    group_position integer,
    task_type text not null
      constraint writing_assignments_task_type_check check (task_type in (
        'email','academic_discussion','build_sentence','ctw','rdl','rap','full_set'
      )),
    question_source text not null
      constraint writing_assignments_question_source_value_check
      check (question_source in ('question_bank','custom')),
    question_id text,
    question_snapshot jsonb not null default '{}'::jsonb
      constraint writing_assignments_question_snapshot_object_check
      check (jsonb_typeof(question_snapshot) = 'object'),
    due_at timestamptz,
    status text not null default 'active'
      constraint writing_assignments_status_check check (status in ('active','withdrawn')),
    deleted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint writing_assignments_subject_item_type_check check (
      (subject = 'writing' and task_type in ('email','academic_discussion','build_sentence'))
      or (subject = 'reading' and task_type in ('ctw','rdl','rap','full_set'))
    )
  );
  create table public.writing_assignment_students (
    assignment_id uuid not null references public.writing_assignments(assignment_id) on delete cascade,
    student_id uuid not null references public.profiles(id) on delete cascade,
    assigned_at timestamptz not null default now(),
    sort_order integer,
    primary key (assignment_id, student_id)
  );
  create table public.writing_attempts (
    attempt_id uuid primary key default gen_random_uuid(),
    assignment_id uuid references public.writing_assignments(assignment_id) on delete set null,
    user_id uuid not null,
    status text not null default 'draft',
    attempt_kind text not null default 'original',
    submitted_at timestamptz
  );

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
  create table public.reading_logical_items (
    logical_item_id text primary key,
    module text not null,
    title text
  );
  create table public.reading_questions (
    question_id text primary key,
    logical_item_id text not null,
    question_order integer not null default 0,
    module text not null,
    question_type text not null,
    question_category text,
    stem text not null default '',
    passage_id text,
    correct_option_id text,
    insert_sentence text,
    correct_anchor_id text,
    target_paragraph_id text,
    correct_sentence_id text
  );
  create table public.reading_question_options (
    question_id text not null,
    option_id text not null,
    primary key (question_id, option_id)
  );
  create table public.reading_rap_insertion_anchors (
    question_id text not null,
    anchor_id text not null,
    primary key (question_id, anchor_id)
  );
  create table public.reading_passage_sentences (
    passage_id text not null,
    paragraph_id text not null,
    sentence_id text not null,
    primary key (passage_id, paragraph_id, sentence_id)
  );
  create table public.reading_question_category_session_answers (
    answer_id uuid primary key default gen_random_uuid(),
    session_id uuid not null,
    logical_item_id text not null,
    question_id text not null,
    answer_kind text not null,
    student_answer text,
    is_correct boolean not null,
    question_time_seconds integer not null default 0,
    unique (session_id, question_id)
  );
  create table public.reading_question_category_sessions (
    session_id uuid primary key default gen_random_uuid(),
    student_id uuid not null,
    question_category text not null,
    amount integer not null check (amount in (5,10,15,20)),
    manifest jsonb not null,
    progress jsonb not null default '{}'::jsonb,
    draft jsonb not null default '{}'::jsonb,
    status text not null default 'active' check (status in ('active','completed')),
    elapsed_seconds integer not null default 0,
    total_points integer not null default 0 check (total_points between 0 and 20),
    correct_points integer not null default 0 check (correct_points between 0 and total_points),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    completed_at timestamptz,
    start_request_id uuid,
    origin text not null default 'self_practice',
    assignment_id uuid
  );
  create table public.bas_grammar_practice_sessions (
    session_id uuid primary key default gen_random_uuid(),
    student_id uuid not null,
    category text not null,
    mode text not null default 'random' check (mode = 'random'),
    origin text not null default 'self_practice',
    assignment_id uuid,
    start_request_id uuid,
    manifest jsonb not null,
    draft jsonb not null default '{}'::jsonb,
    status text not null default 'active' check (status in ('active','completed')),
    elapsed_seconds integer not null default 0,
    total_questions integer not null default 0 check (total_questions between 0 and 10),
    correct_count integer not null default 0 check (correct_count between 0 and total_questions),
    attempt_id uuid,
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    updated_at timestamptz not null default now()
  );

  create function public.practice_entitlement_enforcement_enabled()
  returns boolean language sql stable set search_path = '' as $$ select false $$;
  create function public.practice_grammar_question_has_tag(p_tags text, p_tag text)
  returns boolean language sql immutable set search_path = '' as $$
    select exists (
      select 1 from unnest(string_to_array(coalesce(p_tags,''), ';')) tag
      where btrim(tag) = btrim(p_tag)
    )
  $$;
  create function public.can_use_student_experience()
  returns boolean language sql stable set search_path = '' as $$
    select exists (select 1 from public.profiles where id = auth.uid() and is_active)
  $$;
  create function public.apply_student_wrong_question_events(uuid, date, jsonb)
  returns void language plpgsql as $$ begin return; end; $$;
  create function public.reading_category_session_json(
    p_session public.reading_question_category_sessions
  ) returns jsonb language sql stable set search_path = '' as $$
    select jsonb_build_object('sessionId', p_session.session_id)
  $$;
  create function public.reading_category_answers_json(uuid, text default null)
  returns jsonb language sql stable set search_path = '' as $$
    select '[]'::jsonb
  $$;

  insert into public.profiles(id, role, full_name) values
    ('${TEACHER}', 'teacher', 'Teacher'),
    ('${STUDENT}', 'student', 'Student One'),
    ('${STUDENT2}', 'student', 'Student Two');
  insert into public.teacher_student_bindings(teacher_id, student_id, domain) values
    ('${TEACHER}', '${STUDENT}', 'writing'),
    ('${TEACHER}', '${STUDENT}', 'reading'),
    ('${TEACHER}', '${STUDENT2}', 'writing'),
    ('${TEACHER}', '${STUDENT2}', 'reading');
  insert into public.teacher_classes(class_id, teacher_id, name, subjects) values
    ('${CLASS}', '${TEACHER}', 'Class A', array['writing','reading']);
  insert into public.class_members(class_id, student_id) values
    ('${CLASS}', '${STUDENT}'),
    ('${CLASS}', '${STUDENT2}');

  insert into public.questions(
    question_id, set_id, set_title, question_order, prompt, sentence_template,
    blank_count, options_text, final_sentence, grammar_tags_text
  )
  select 'bas-tense-' || n, 'set-tense', 'Tense set', n, 'Tense prompt ' || n,
    '[blank]', 1, 'a|b|c', 'Tense sentence ' || n, '时态'
  from generate_series(1, 12) n;
  insert into public.questions(
    question_id, set_id, set_title, question_order, prompt, sentence_template,
    blank_count, options_text, final_sentence, grammar_tags_text
  )
  select 'bas-clause-' || n, 'set-clause', 'Clause set', n, 'Clause prompt ' || n,
    '[blank]', 1, 'a|b|c', 'Clause sentence ' || n, '从句'
  from generate_series(1, 12) n;
  insert into public.questions(
    question_id, set_id, set_title, question_order, prompt, sentence_template,
    blank_count, options_text, final_sentence, grammar_tags_text
  )
  select 'bas-nonfinite-' || n, 'set-nonfinite', 'Nonfinite set', n, 'Nonfinite prompt ' || n,
    '[blank]', 1, 'a|b|c', 'Nonfinite sentence ' || n, '非谓语动词'
  from generate_series(1, 12) n;

  insert into public.reading_logical_items(logical_item_id, module) values
    ('logical-fact-1','rap'),('logical-fact-2','rap'),
    ('logical-inf-1','rap'),('logical-inf-2','rap'),
    ('logical-vocab-1','rap'),('logical-vocab-2','rap');
  insert into public.reading_questions(
    question_id, logical_item_id, question_order, module, question_type,
    question_category, stem, passage_id, correct_option_id
  ) values
    ${RAP_QUESTIONS.map(([questionId, category, logicalItemId], index) => `(
      '${questionId}', '${logicalItemId}', ${index + 1}, 'rap', 'rap_multiple_choice',
      '${category}', 'Stem ${questionId}', 'passage-${logicalItemId}', 'option-${questionId}'
    )`).join(",")};
  insert into public.reading_question_options(question_id, option_id)
  select question_id, 'option-' || question_id from public.reading_questions;
`;

function basManifest(rows) {
  const questions = [];
  for (const row of rows) {
    for (let index = 0; index < row.count; index += 1) {
      const questionId = BAS_QUESTIONS_BY_CATEGORY[row.category][index];
      questions.push({
        blank_count: 1,
        category: row.category,
        distractors_text: "",
        options_text: "a|b|c",
        prompt: `${row.category} prompt ${index + 1}`,
        question_id: questionId,
        question_order: questions.length + 1,
        sentence_template: "[blank]",
        set_id: `set-${row.category}`,
        set_title: `${row.category} set`
      });
    }
  }
  const totalQuestions = rows.reduce((sum, row) => sum + row.count, 0);
  const categorySummary = rows.map((row) => `${row.category} ${row.count}题`).join(" + ");
  return {
    answers: Object.fromEntries(questions.map((question) => [
      question.question_id,
      { correct_order_text: "a|b|c", final_sentence: `${question.category} answer` }
    ])),
    categories: rows,
    categorySummary,
    item_id: crypto.randomUUID(),
    item_type: "bas_category",
    kind: "bas_category_assignment",
    questions,
    set_title: categorySummary,
    totalQuestions,
    version: 1
  };
}

function rapManifest(rows) {
  const groupsByLogical = new Map();
  const categoryCounts = new Map();
  for (const row of rows) {
    const pool = RAP_QUESTIONS.filter((question) => question[1] === row.category);
    for (const [questionId, category, logicalItemId] of pool.slice(0, row.count)) {
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      const group = groupsByLogical.get(logicalItemId) ?? {
        logicalItemId,
        targets: [],
        title: logicalItemId
      };
      group.targets.push({ questionCategory: category, questionId, slotId: null });
      groupsByLogical.set(logicalItemId, group);
    }
  }
  const totalQuestions = rows.reduce((sum, row) => sum + row.count, 0);
  const categorySummary = rows.map((row) => `${row.category} ${row.count}题`).join(" + ");
  return {
    answers: Object.fromEntries(
      [...groupsByLogical.values()]
        .flatMap((group) => group.targets)
        .map((target) => [
          target.questionId,
          { correct_option_id: `option-${target.questionId}` }
        ])
    ),
    categories: rows,
    categorySummary,
    groups: [...groupsByLogical.values()],
    item_id: crypto.randomUUID(),
    item_type: "rap_category",
    kind: "category_assignment",
    set_title: categorySummary,
    totalQuestions,
    version: 1
  };
}

async function freshDb() {
  const db = new PGlite();
  await db.exec(FIXTURE);
  await db.exec(PHASE5);
  await db.exec(MIXED);
  return db;
}

async function claim(db, userId) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
}

async function createCategoryAssignment(db, input) {
  return (await db.query(
    `select public.create_category_writing_assignment_group(
      $1::uuid, $2::jsonb, $3::uuid[], $4::text, $5::boolean, $6::text, $7::uuid
    ) as payload`,
    [
      input.teacherId ?? TEACHER,
      JSON.stringify({
        due_at: null,
        question_id: input.manifest.item_id,
        question_snapshot: input.manifest,
        question_source: "question_bank",
        task_type: input.manifest.item_type
      }),
      input.studentIds,
      input.title ?? "分类练习作业",
      false,
      input.subject,
      input.classId ?? null
    ]
  )).rows[0].payload;
}

function normalBasAssignmentItem(questionId = "bas-normal-1") {
  return {
    due_at: null,
    question_id: questionId,
    question_snapshot: {
      set_title: "BAS 套题",
      source_set_id: "set-tense"
    },
    question_source: "question_bank",
    task_type: "build_sentence"
  };
}

async function createMixedAssignment(db, input) {
  const assignments = [
    normalBasAssignmentItem(),
    {
      due_at: null,
      question_id: input.manifest.item_id,
      question_snapshot: input.manifest,
      question_source: "question_bank",
      task_type: input.manifest.item_type
    }
  ];
  if (input.classId) {
    return (await db.query(
      `select public.create_writing_assignment_group(
        $1::uuid, $2::jsonb, $3::uuid[], $4::text, $5::boolean, $6::text, $7::uuid
      ) as payload`,
      [
        input.teacherId ?? TEACHER,
        JSON.stringify(assignments),
        [],
        input.title ?? "混合作业",
        false,
        input.subject,
        input.classId
      ]
    )).rows[0].payload;
  }
  return (await db.query(
    `select public.create_writing_assignment_group(
      $1::uuid, $2::jsonb, $3::uuid[], $4::text, $5::boolean, $6::text
    ) as payload`,
    [
      input.teacherId ?? TEACHER,
      JSON.stringify(assignments),
      input.studentIds,
      input.title ?? "混合作业",
      false,
      input.subject
    ]
  )).rows[0].payload;
}

async function startBas(db, studentId, assignmentId, requestId) {  await claim(db, studentId);
  return (await db.query(
    "select public.get_or_create_bas_category_assignment_session($1::uuid,$2::uuid) as payload",
    [assignmentId, requestId]
  )).rows[0].payload;
}

async function startRap(db, studentId, assignmentId, requestId) {
  await claim(db, studentId);
  return (await db.query(
    "select public.get_or_create_rap_category_assignment_session($1::uuid,$2::uuid) as payload",
    [assignmentId, requestId]
  )).rows[0].payload;
}

test("v5 migration is additive and adds category Assignment types without a second platform", () => {
  assert.equal((PHASE5.match(/^begin;/gm) ?? []).length, 1);
  assert.equal((PHASE5.match(/^commit;/gm) ?? []).length, 1);
  assert.equal((PHASE5.match(/\$\$/g) ?? []).length % 2, 0);
  assert.match(PHASE5, /create_category_writing_assignment_group/);
  assert.match(PHASE5, /update_withdrawn_category_assignment_group/);
  assert.match(PHASE5, /get_or_create_bas_category_assignment_session/);
  assert.match(PHASE5, /get_or_create_rap_category_assignment_session/);
  assert.match(PHASE5, /bas_category/);
  assert.match(PHASE5, /rap_category/);
  assert.match(PHASE5, /validate_category_assignment_manifest/);
  assert.match(PHASE5, /category_assignment_answer_snapshots/);
  assert.match(PHASE5, /v_manifest := v_assignment\.question_snapshot - 'answers'/);
  assert.doesNotMatch(PHASE5, /enforcement_enabled\s*=\s*true/i);
  assert.doesNotMatch(PHASE5, /insert\s+into\s+public\.student_practice_unlocks/i);
  assert.doesNotMatch(PHASE5, /create table public\.(?:bas_grammar_practice_sessions|reading_question_category_sessions)/i);
});

test("BAS category Assignment creation freezes a multi-category manifest and shares it across students", async () => {
  const db = await freshDb();
  try {
    const rows = [
      { category: "时态", count: 5 },
      { category: "从句", count: 10 }
    ];
    const manifest = basManifest(rows);
    const created = await createCategoryAssignment(db, {
      manifest,
      studentIds: [STUDENT, STUDENT2],
      subject: "writing"
    });
    assert.equal(created.assignment_ids.length, 1);
    const assignmentId = created.assignment_ids[0];

    const assignment = (await db.query(
      "select task_type, subject, question_id, question_snapshot, teacher_id from public.writing_assignments where assignment_id = $1",
      [assignmentId]
    )).rows[0];
    assert.equal(assignment.task_type, "bas_category");
    assert.equal(assignment.subject, "writing");
    assert.equal(assignment.question_id, manifest.item_id);
    assert.equal(assignment.question_snapshot.totalQuestions, 15);
    assert.equal(assignment.question_snapshot.categories.length, 2);
    assert.equal(assignment.question_snapshot.answers, undefined);
    const answerSnapshot = (await db.query(
      "select answers from public.category_assignment_answer_snapshots where assignment_id = $1",
      [assignmentId]
    )).rows[0];
    assert.equal(Object.keys(answerSnapshot.answers).length, 15);
    assert.equal((await db.query(
      "select count(*)::integer as n from public.writing_assignment_students where assignment_id = $1",
      [assignmentId]
    )).rows[0].n, 2);

    const first = await startBas(db, STUDENT, assignmentId, REQUEST_BAS_1);
    const second = await startBas(db, STUDENT2, assignmentId, REQUEST_BAS_2);
    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.equal(first.session.origin, "teacher_assigned");
    assert.equal(first.session.assignmentId, assignmentId);
    assert.equal(first.session.questions.length, 15);
    const storedBasManifest = (await db.query(
      "select manifest from public.bas_grammar_practice_sessions where session_id = $1",
      [first.session.sessionId]
    )).rows[0].manifest;
    assert.equal(storedBasManifest.answers, undefined);
    assert.deepEqual(first.session.categories, rows);
    assert.deepEqual(
      first.session.questions.map((question) => question.question_id),
      second.session.questions.map((question) => question.question_id)
    );
    assert.notEqual(first.session.sessionId, second.session.sessionId);
    assert.equal(first.session.mode, "assignment");
  } finally {
    await db.close();
  }
});

test("BAS category Start is owner-authorized, idempotent and Retake uses the same manifest", async () => {
  const db = await freshDb();
  try {
    const manifest = basManifest([{ category: "时态", count: 5 }]);
    const created = await createCategoryAssignment(db, { manifest, studentIds: [STUDENT], subject: "writing" });
    const assignmentId = created.assignment_ids[0];
    const first = await startBas(db, STUDENT, assignmentId, REQUEST_BAS_1);
    const retry = await startBas(db, STUDENT, assignmentId, REQUEST_BAS_1);
    const sameActive = await startBas(db, STUDENT, assignmentId, REQUEST_BAS_2);
    assert.equal(retry.created, false);
    assert.equal(sameActive.created, false);
    assert.equal(retry.session.sessionId, first.session.sessionId);
    assert.equal(sameActive.session.sessionId, first.session.sessionId);

    await db.query(
      `update public.bas_grammar_practice_sessions
       set status = 'completed', completed_at = now(), total_questions = 5,
           correct_count = 3, draft = '{}'::jsonb
       where session_id = $1`,
      [first.session.sessionId]
    );
    const retake = await startBas(db, STUDENT, assignmentId, REQUEST_BAS_2);
    assert.equal(retake.created, true);
    assert.notEqual(retake.session.sessionId, first.session.sessionId);
    assert.deepEqual(
      retake.session.questions.map((question) => question.question_id),
      first.session.questions.map((question) => question.question_id)
    );
    assert.equal(retake.session.origin, "teacher_assigned");
  } finally {
    await db.close();
  }
});

test("RAP category Assignment supports multiple categories, idempotent Start and multi-group submit", async () => {
  const db = await freshDb();
  try {
    const rows = [
      { category: "事实信息题", count: 2 },
      { category: "推断题", count: 2 }
    ];
    const manifest = rapManifest(rows);
    const created = await createCategoryAssignment(db, {
      manifest,
      studentIds: [STUDENT],
      subject: "reading"
    });
    const assignmentId = created.assignment_ids[0];
    const assignment = (await db.query(
      "select task_type, subject, question_snapshot from public.writing_assignments where assignment_id = $1",
      [assignmentId]
    )).rows[0];
    assert.equal(assignment.task_type, "rap_category");
    assert.equal(assignment.question_snapshot.totalQuestions, 4);

    const first = await startRap(db, STUDENT, assignmentId, REQUEST_RAP_1);
    assert.equal(first.created, true);
    assert.equal(first.session.origin, "teacher_assigned");
    assert.equal(first.session.amount, 4);
    assert.equal(first.session.totalQuestions, 4);
    assert.deepEqual(first.session.categories, rows);
    const storedRapManifest = (await db.query(
      "select manifest from public.reading_question_category_sessions where session_id = $1",
      [first.session.sessionId]
    )).rows[0].manifest;
    assert.equal(storedRapManifest.answers, undefined);
    const retry = await startRap(db, STUDENT, assignmentId, REQUEST_RAP_2);
    assert.equal(retry.created, false);
    assert.equal(retry.session.sessionId, first.session.sessionId);

    // Submit each frozen group; only the last call finalizes the whole session.
    const groups = first.session.groups;
    let revision = 1;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const answers = group.targets.map((target) => ({
        kind: "option",
        questionId: target.questionId,
        slotId: null,
        studentAnswer: `option-${target.questionId}`,
        questionTimeSeconds: 10
      }));
      const result = (await db.query(
        `select public.submit_reading_question_category_group(
          $1::uuid,$2::text,$3::integer,$4::jsonb,$5::boolean,$6::bigint
        ) as payload`,
        [
          first.session.sessionId,
          group.logicalItemId,
          10,
          JSON.stringify(answers),
          index === groups.length - 1,
          revision
        ]
      )).rows[0].payload;
      revision += 1;
      if (index === groups.length - 1) {
        assert.equal(result.session.status, "completed");
        assert.equal(result.session.correctPoints, 4);
        assert.equal(result.session.totalPoints, 4);
      }
    }
  } finally {
    await db.close();
  }
});

test("withdraw is blocked after a category session starts and category edit stays one item", async () => {
  const db = await freshDb();
  try {
    const manifest = basManifest([{ category: "时态", count: 5 }]);
    const created = await createCategoryAssignment(db, {
      manifest,
      studentIds: [STUDENT],
      subject: "writing"
    });
    await startBas(db, STUDENT, created.assignment_ids[0], REQUEST_BAS_1);
    await assert.rejects(
      db.query(
        "select public.withdraw_writing_assignment_group($1::uuid,$2::uuid)",
        [TEACHER, created.group_id]
      ),
      /ASSIGNMENT_GROUP_HAS_ATTEMPT/
    );

    // A separate no-session Assignment can be withdrawn and edited atomically.
    const secondManifest = basManifest([{ category: "从句", count: 5 }]);
    const second = await createCategoryAssignment(db, {
      manifest: secondManifest,
      studentIds: [STUDENT],
      subject: "writing",
      title: "Second"
    });
    await db.query(
      "select public.withdraw_writing_assignment_group($1::uuid,$2::uuid)",
      [TEACHER, second.group_id]
    );
    const replacement = basManifest([{ category: "非谓语动词", count: 6 }]);
    const edited = (await db.query(
      `select public.update_withdrawn_category_assignment_group(
        $1::uuid,$2::uuid,$3::uuid,$4::text,$5::jsonb,$6::uuid[],$7::timestamptz,$8::boolean,$9::uuid
      ) as payload`,
      [
        TEACHER,
        second.group_id,
        null,
        "Second edited",
        JSON.stringify({
          assignment_id: second.assignment_ids[0],
          question_id: replacement.item_id,
          question_snapshot: replacement,
          question_source: "question_bank",
          task_type: "bas_category"
        }),
        [STUDENT2],
        null,
        true,
        null
      ]
    )).rows[0].payload;
    assert.equal(edited.status, "active");
    const row = (await db.query(
      "select task_type, question_id, question_snapshot, status from public.writing_assignments where assignment_id = $1",
      [second.assignment_ids[0]]
    )).rows[0];
    assert.equal(row.task_type, "bas_category");
    assert.equal(row.question_id, replacement.item_id);
    assert.equal(row.question_snapshot.totalQuestions, 6);
    assert.equal(row.status, "active");
    assert.equal((await db.query(
      "select count(*)::integer as n from public.writing_assignment_students where assignment_id = $1",
      [second.assignment_ids[0]]
    )).rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test("class-mode category Assignment uses the existing class membership and subject binding", async () => {
  const db = await freshDb();
  try {
    const manifest = basManifest([{ category: "时态", count: 5 }]);
    const created = await createCategoryAssignment(db, {
      manifest,
      classId: CLASS,
      studentIds: [],
      subject: "writing"
    });
    const assignmentId = created.assignment_ids[0];
    const members = (await db.query(
      "select student_id from public.writing_assignment_students where assignment_id = $1 order by student_id",
      [assignmentId]
    )).rows.map((row) => row.student_id);
    assert.deepEqual(members.sort(), [STUDENT, STUDENT2].sort());
    assert.equal((await db.query(
      "select class_id from public.writing_assignment_groups where group_id = $1",
      [created.group_id]
    )).rows[0].class_id, CLASS);
  } finally {
    await db.close();
  }
});

test("mixed create keeps normal items and one category manifest in one Assignment Group", async () => {
  const db = await freshDb();
  try {
    const manifest = basManifest([{ category: "时态", count: 5 }]);
    const created = await createMixedAssignment(db, {
      manifest,
      studentIds: [STUDENT, STUDENT2],
      subject: "writing"
    });
    assert.equal(created.assignment_ids.length, 2);
    const rows = (await db.query(
      `select assignment_id,group_id,group_position,task_type,subject,question_id,question_snapshot
       from public.writing_assignments
       where group_id = $1
       order by group_position`,
      [created.group_id]
    )).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.task_type), ["build_sentence", "bas_category"]);
    assert.deepEqual(rows.map((row) => row.subject), ["writing", "writing"]);
    assert.equal(rows[0].question_snapshot.answers, undefined);
    assert.equal(rows[1].question_snapshot.answers, undefined);
    assert.equal(rows[1].question_id, manifest.item_id);
    const snapshot = (await db.query(
      "select answers from public.category_assignment_answer_snapshots where assignment_id = $1",
      [rows[1].assignment_id]
    )).rows[0];
    assert.equal(Object.keys(snapshot.answers).length, 5);
    assert.equal((await db.query(
      "select count(*)::integer as n from public.writing_assignment_students where assignment_id = any($1::uuid[])",
      [rows.map((row) => row.assignment_id)]
    )).rows[0].n, 4);

    const started = await startBas(db, STUDENT, rows[1].assignment_id, REQUEST_BAS_1);
    assert.equal(started.created, true);
    assert.equal(started.session.questions.length, 5);
  } finally {
    await db.close();
  }
});

test("mixed migration keeps pure normal creation and rejects two category manifests", async () => {
  const db = await freshDb();
  try {
    const created = (await db.query(
      `select public.create_writing_assignment_group(
        $1::uuid,$2::jsonb,$3::uuid[],$4::text,$5::boolean,$6::text
      ) as payload`,
      [
        TEACHER,
        JSON.stringify([
          {
            due_at: null,
            question_id: "bas-normal-1",
            question_snapshot: { set_title: "BAS 套题一", source_set_id: "set-tense" },
            question_source: "question_bank",
            task_type: "build_sentence"
          },
          {
            due_at: null,
            question_id: "question-email-1",
            question_snapshot: { set_title: "Email 一" },
            question_source: "question_bank",
            task_type: "email"
          }
        ]),
        [STUDENT],
        "纯普通作业",
        false,
        "writing"
      ]
    )).rows[0].payload;
    assert.equal(created.assignment_ids.length, 2);
    assert.equal((await db.query(
      "select count(*)::integer as n from public.category_assignment_answer_snapshots where assignment_id = any($1::uuid[])",
      [created.assignment_ids]
    )).rows[0].n, 0);
    assert.equal((await db.query(
      "select count(*)::integer as n from public.writing_assignments where group_id = $1 and deleted_at is null",
      [created.group_id]
    )).rows[0].n, 2);

    await assert.rejects(
      db.query(
        `select public.create_writing_assignment_group(
          $1::uuid,$2::jsonb,$3::uuid[],$4::text,$5::boolean,$6::text
        )`,
        [
          TEACHER,
          JSON.stringify([
            {
              due_at: null,
              question_id: "category-a",
              question_snapshot: basManifest([{ category: "时态", count: 5 }]),
              question_source: "question_bank",
              task_type: "bas_category"
            },
            {
              due_at: null,
              question_id: "category-b",
              question_snapshot: basManifest([{ category: "从句", count: 5 }]),
              question_source: "question_bank",
              task_type: "bas_category"
            }
          ]),
          [STUDENT],
          "非法双分类",
          false,
          "writing"
        ]
      ),
      /INVALID_CATEGORY_ASSIGNMENT_MANIFEST/
    );
  } finally {
    await db.close();
  }
});

test("mixed class create and withdrawn edit stay in one group with the frozen category answer map", async () => {
  const db = await freshDb();
  try {
    const manifest = basManifest([{ category: "从句", count: 5 }]);
    const created = await createMixedAssignment(db, {
      classId: CLASS,
      manifest,
      subject: "writing"
    });
    assert.equal(created.assignment_ids.length, 2);
    assert.equal((await db.query(
      "select count(*)::integer as n from public.writing_assignment_students where assignment_id = any($1::uuid[])",
      [created.assignment_ids]
    )).rows[0].n, 4);

    const withdrawn = (await db.query(
      "select public.withdraw_writing_assignment_group($1::uuid,$2::uuid) as payload",
      [TEACHER, created.group_id]
    )).rows[0].payload;
    assert.equal(withdrawn.withdrawn_count, 2);

    const categoryAssignmentId = created.assignment_ids[1];
    const normalAssignmentId = created.assignment_ids[0];
    const edited = (await db.query(
      `select public.update_withdrawn_writing_assignment_group(
        $1::uuid,$2::uuid,null,$3::text,$4::jsonb,$5::uuid[],null,true,null
      ) as payload`,
      [
        TEACHER,
        created.group_id,
        "混合编辑作业",
        JSON.stringify([
          {
            assignment_id: normalAssignmentId,
            task_type: "build_sentence",
            question_source: "question_bank",
            question_id: "bas-normal-2",
            question_snapshot: { set_title: "BAS 套题二", source_set_id: "set-clause" }
          },
          {
            assignment_id: categoryAssignmentId,
            task_type: "bas_category",
            question_source: "question_bank",
            question_id: manifest.item_id,
            question_snapshot: manifest
          }
        ]),
        [STUDENT, STUDENT2]
      ]
    )).rows[0].payload;
    assert.equal(edited.item_count, 2);
    assert.equal(edited.removed_item_count, 0);
    const visible = (await db.query(
      `select assignment_id,task_type,status,question_snapshot
       from public.writing_assignments
       where group_id = $1 and deleted_at is null
       order by group_position`,
      [created.group_id]
    )).rows;
    assert.equal(visible.length, 2);
    assert.deepEqual(visible.map((row) => row.status), ["active", "active"]);
    assert.equal(visible[1].question_snapshot.answers, undefined);
    assert.ok((await db.query(
      "select answers from public.category_assignment_answer_snapshots where assignment_id = $1",
      [categoryAssignmentId]
    )).rows[0].answers);
  } finally {
    await db.close();
  }
});

test("v5 migration is re-runnable and preserves category Assignments and sessions", async () => {  const db = await freshDb();
  try {
    const manifest = basManifest([{ category: "时态", count: 5 }]);
    const created = await createCategoryAssignment(db, {
      manifest,
      studentIds: [STUDENT],
      subject: "writing"
    });
    const started = await startBas(db, STUDENT, created.assignment_ids[0], REQUEST_BAS_1);
    await db.exec(PHASE5);
    const row = (await db.query(
      "select task_type, question_snapshot from public.writing_assignments where assignment_id = $1",
      [created.assignment_ids[0]]
    )).rows[0];
    assert.equal(row.task_type, "bas_category");
    assert.equal(row.question_snapshot.totalQuestions, 5);
    const session = (await db.query(
      "select origin, assignment_id, status from public.bas_grammar_practice_sessions where session_id = $1",
      [started.session.sessionId]
    )).rows[0];
    assert.equal(session.origin, "teacher_assigned");
    assert.equal(session.assignment_id, created.assignment_ids[0]);
    assert.equal(session.status, "active");
  } finally {
    await db.close();
  }
});

test("v5 keeps the phase-4 single-category self-practice session paths compatible", async () => {
  const db = await freshDb();
  try {
    const selfManifest = {
      category: "时态",
      kind: "bas_grammar",
      questions: BAS_QUESTIONS_BY_CATEGORY.时态.slice(0, 10).map((questionId, index) => ({
        blank_count: 1,
        options_text: "a|b|c",
        prompt: `Prompt ${index + 1}`,
        question_id: questionId,
        sentence_template: "[blank]"
      })),
      version: 1
    };
    const bas = (await db.query(
      `insert into public.bas_grammar_practice_sessions(
        student_id, category, mode, origin, manifest
      ) values ($1, '时态', 'random', 'self_practice', $2::jsonb)
      returning session_id`,
      [STUDENT, JSON.stringify(selfManifest)]
    )).rows[0];
    const basJson = (await db.query(
      "select public.bas_grammar_session_json(session) as payload from public.bas_grammar_practice_sessions session where session_id = $1",
      [bas.session_id]
    )).rows[0].payload;
    assert.equal(basJson.origin, "self_practice");
    assert.equal(basJson.mode, "random");
    assert.equal(basJson.questions.length, 10);

    const rapManifest = {
      category: "事实信息题",
      groups: [
        {
          logicalItemId: "logical-fact-1",
          targets: ["rap-fact-1", "rap-fact-2"].map((questionId) => ({
            questionId,
            slotId: null
          })),
          title: "logical-fact-1"
        },
        {
          logicalItemId: "logical-fact-2",
          targets: ["rap-fact-3", "rap-fact-4"].map((questionId) => ({
            questionId,
            slotId: null
          })),
          title: "logical-fact-2"
        }
      ],
      kind: "question_category",
      version: 1
    };
    const rap = (await db.query(
      `insert into public.reading_question_category_sessions(
        student_id, question_category, amount, manifest, origin
      ) values ($1, '事实信息题', 5, $2::jsonb, 'self_practice')
      returning session_id`,
      [STUDENT, JSON.stringify(rapManifest)]
    )).rows[0];
    const rapJson = (await db.query(
      "select public.reading_category_session_json(session) as payload from public.reading_question_category_sessions session where session_id = $1",
      [rap.session_id]
    )).rows[0].payload;
    assert.equal(rapJson.origin, "self_practice");
    assert.equal(rapJson.totalQuestions, 4);
    assert.equal(rapJson.assignmentId, null);
  } finally {
    await db.close();
  }
});

test("v5 rejects forged or insufficient manifests and unauthorized students", async () => {
  const db = await freshDb();
  try {
    const manifest = basManifest([{ category: "时态", count: 5 }]);
    const duplicated = structuredClone(manifest);
    duplicated.questions[1].question_id = duplicated.questions[0].question_id;
    await assert.rejects(
      createCategoryAssignment(db, { manifest: duplicated, studentIds: [STUDENT], subject: "writing" }),
      /INVALID_CATEGORY_ASSIGNMENT_MANIFEST/
    );
    const insufficient = basManifest([{ category: "时态", count: 20 }]);
    insufficient.questions = insufficient.questions.slice(0, 5);
    await assert.rejects(
      createCategoryAssignment(db, { manifest: insufficient, studentIds: [STUDENT], subject: "writing" }),
      /INVALID_CATEGORY_ASSIGNMENT_MANIFEST/
    );
    const created = await createCategoryAssignment(db, { manifest, studentIds: [STUDENT], subject: "writing" });
    await claim(db, "10000000-0000-4000-8000-000000000099");
    await assert.rejects(
      startBas(db, "10000000-0000-4000-8000-000000000099", created.assignment_ids[0], REQUEST_BAS_1),
      /BAS_GRAMMAR_UNAUTHORIZED|ASSIGNMENT_NOT_ASSIGNED/
    );
  } finally {
    await db.close();
  }
});

test("server draw freezes exact per-category counts, unique questions and result answers", async () => {
  const {
    drawBasCategoryAssignmentManifest,
    drawRapCategoryAssignmentManifest
  } = require("../lib/categoryAssignment.server.ts");
  const basQuestions = [];
  for (const category of BAS_CATEGORIES) {
    for (let index = 1; index <= 12; index += 1) {
      basQuestions.push({
        blank_count: 1,
        correct_order_text: "a|b|c",
        distractors_text: "",
        final_sentence: `${category} sentence ${index}`,
        grammar_tags_text: `["${category}"]`,
        options_text: "a|b|c",
        prompt: `${category} prompt ${index}`,
        question_id: `${category}-${index}`,
        question_order: index,
        sentence_template: "[blank]",
        set_id: `set-${category}`,
        set_title: `${category} set`
      });
    }
  }
  const rapQuestions = [];
  RAP_QUESTIONS.forEach(([questionId, category, logicalItemId], index) => {
    rapQuestions.push({
      correct_anchor_id: null,
      correct_option_id: `option-${questionId}`,
      correct_sentence_id: null,
      logical_item_id: logicalItemId,
      module: "rap",
      question_category: category,
      question_id: questionId,
      question_order: index + 1,
      question_type: "rap_multiple_choice"
    });
  });
  const db = createMockSupabase({
    questions: basQuestions,
    reading_logical_items: RAP_QUESTIONS
      .map(([, , logicalItemId]) => logicalItemId)
      .filter((value, index, array) => array.indexOf(value) === index)
      .map((logicalItemId) => ({
        first_seen_date: "2026-11-15",
        first_seen_source_label: "1.1A",
        first_seen_source_order: 1,
        logical_item_id: logicalItemId,
        module: "rap",
        title: logicalItemId
      })),
    reading_questions: rapQuestions
  });

  const basManifest = await drawBasCategoryAssignmentManifest(
    db,
    [{ category: "时态", count: 5 }, { category: "从句", count: 7 }],
    12
  );
  assert.equal(basManifest.totalQuestions, 12);
  assert.equal(basManifest.questions.length, 12);
  assert.equal(new Set(basManifest.questions.map((question) => question.question_id)).size, 12);
  assert.equal(basManifest.questions.filter((question) => question.category === "时态").length, 5);
  assert.equal(basManifest.questions.filter((question) => question.category === "从句").length, 7);
  assert.equal(Object.keys(basManifest.answers).length, 12);

  const rapManifest = await drawRapCategoryAssignmentManifest(
    db,
    [{ category: "事实信息题", count: 2 }, { category: "推断题", count: 2 }],
    4
  );
  const rapTargets = rapManifest.groups.flatMap((group) => group.targets);
  assert.equal(rapManifest.totalQuestions, 4);
  assert.equal(rapTargets.length, 4);
  assert.equal(new Set(rapTargets.map((target) => target.questionId)).size, 4);
  assert.equal(rapTargets.filter((target) => target.questionCategory === "事实信息题").length, 2);
  assert.equal(rapTargets.filter((target) => target.questionCategory === "推断题").length, 2);
  assert.equal(Object.keys(rapManifest.answers).length, 4);

  await assert.rejects(
    drawBasCategoryAssignmentManifest(db, [{ category: "时态", count: 20 }], 20),
    /当前可抽取 12 题/
  );
});

test("category Assignment practice/result actions route to existing session and result pages", () => {
  const { teacherAssignmentItemAction } = require("../lib/teacherAssignmentItems.ts");
  const {
    studentAssignmentPracticeHref,
    studentAssignmentResultHref
  } = require("../lib/studentAssignmentPractice.ts");

  const basAction = teacherAssignmentItemAction({
    itemType: "bas_category",
    student: {
      available_result: {
        attempt_id: "attempt-1",
        completed_at: "2026-11-15T10:30:00Z",
        id: "bas-session-1",
        kind: "bas_category"
      },
      latest_review_status: null,
      latest_submitted_attempt_id: null
    },
    studentId: "student-1"
  });
  assert.equal(basAction.href, "/teacher/students/student-1/details/grammar-random-bas-session-1");

  const rapAction = teacherAssignmentItemAction({
    itemType: "rap_category",
    student: {
      available_result: {
        completed_at: "2026-11-15T10:30:00Z",
        id: "rap-session-1",
        kind: "reading_category"
      },
      latest_review_status: null,
      latest_submitted_attempt_id: null
    },
    studentId: "student-1"
  });
  assert.equal(rapAction.href, "/teacher/students/student-1/reading/category-sessions/rap-session-1");

  assert.equal(
    studentAssignmentPracticeHref({
      assignmentId: "assignment-bas",
      taskType: "bas_category"
    }),
    "/student/grammar-practice/assignment/assignment-bas"
  );
  assert.equal(
    studentAssignmentPracticeHref({
      assignmentId: "assignment-rap",
      taskType: "rap_category"
    }),
    "/student/question-category-practice/assignment/assignment-rap"
  );
  const shell = read("components/student/StudentShell.tsx");
  const rapAssignmentPage = read(
    "app/student/question-category-practice/assignment/[assignmentId]/page.tsx"
  );
  assert.match(
    shell,
    /STUDENT_ROUTES\.questionCategoryPractice\}\/assignment\//
  );
  assert.doesNotMatch(rapAssignmentPage, /StudentPage/);
  assert.match(rapAssignmentPage, /<QuestionCategoryPractice/);
  assert.equal(
    studentAssignmentResultHref({
      attemptId: "attempt-1",
      taskType: "bas_category"
    }),
    "/student/results/attempt-1"
  );
  assert.equal(
    studentAssignmentResultHref({
      attemptId: "rap-session-1",
      taskType: "rap_category"
    }),
    "/student/question-category-practice/sessions/rap-session-1"
  );
});

test("category Assignment result locator uses the category session, not a catalog item attempt", async () => {
  const {
    assignmentStudentResult,
    loadAssignmentStudentResults
  } = require("../lib/assignmentResults.server.ts");
  const db = createMockSupabase({
    bas_grammar_practice_sessions: [
      {
        assignment_id: "assignment-bas",
        attempt_id: "bas-attempt-0",
        completed_at: "2026-11-15T09:30:00Z",
        session_id: "bas-session-0",
        started_at: "2026-11-15T09:00:00Z",
        status: "completed",
        student_id: STUDENT,
        total_questions: 15
      },
      {
        assignment_id: "assignment-bas",
        attempt_id: "bas-attempt-1",
        completed_at: "2026-11-15T10:30:00Z",
        session_id: "bas-session-1",
        started_at: "2026-11-15T10:00:00Z",
        status: "completed",
        student_id: STUDENT,
        total_questions: 15
      }
    ],
    reading_attempts: [],
    reading_full_set_attempts: [],
    reading_question_category_sessions: [
      {
        assignment_id: "assignment-rap",
        completed_at: null,
        created_at: "2026-11-15T11:00:00Z",
        session_id: "rap-session-1",
        status: "active",
        student_id: STUDENT,
        total_points: 0
      }
    ]
  });
  const items = [
    {
      assignmentId: "assignment-bas",
      boundaryAt: "2026-11-15T00:00:00Z",
      itemId: "manifest-bas",
      itemType: "bas_category",
      sourceSetId: null,
      studentId: STUDENT
    },
    {
      assignmentId: "assignment-rap",
      boundaryAt: "2026-11-15T00:00:00Z",
      itemId: "manifest-rap",
      itemType: "rap_category",
      sourceSetId: null,
      studentId: STUDENT
    }
  ];
  const results = await loadAssignmentStudentResults({
    db,
    items,
    studentIds: [STUDENT]
  });
  const bas = assignmentStudentResult(results, "assignment-bas", STUDENT);
  assert.equal(bas.available_result.kind, "bas_category");
  assert.equal(bas.available_result.id, "bas-session-1");
  assert.equal(bas.available_result.attempt_id, "bas-attempt-1");
  assert.equal(bas.available_results.length, 2);
  assert.equal(bas.available_results[0].id, "bas-session-1");
  assert.equal(bas.available_results[1].id, "bas-session-0");
  assert.equal(bas.started, true);
  const rap = assignmentStudentResult(results, "assignment-rap", STUDENT);
  assert.equal(rap.available_result, null);
  assert.equal(rap.started, true);
});

mixedSqlTest("mixed Assignment manual preflight and verify execute read-only", async () => {
  const db = await freshDb();
  try {
    await db.exec(MIXED_PREFLIGHT);
    await db.exec(MIXED_VERIFY);
  } finally {
    await db.close();
  }
});

phase5SqlTest("phase 5 manual preflight, verification and inspection execute", async () => {
  const db = await freshDb();
  try {
    await db.exec(PHASE5_PREFLIGHT);
    await db.exec(PHASE5_VERIFY);
    await db.exec(PHASE5_INSPECT);
  } finally {
    await db.close();
  }
});

test("phase 5 UI/API wiring uses category manifests, positive timer and no quota spend", () => {
  const form = read("components/teacher/TeacherWritingAssignmentForm.tsx");
  const categoryConfig = read("components/teacher/TeacherCategoryAssignmentConfig.tsx");
  const grammarPractice = read("components/GrammarPractice.tsx");
  const categoryPractice = read("components/reading/QuestionCategoryPractice.tsx");
  const practiceSession = read("components/PracticeSession.tsx");
  const server = read("lib/categoryAssignment.server.ts");
  const assignmentResults = read("lib/assignmentResults.server.ts");
  const creationRoute = read("app/api/teacher/writing/assignments/route.ts");
  const batchEditRoute = read("app/api/teacher/writing/assignments/batches/[batchId]/route.ts");
  const mutationServer = read("lib/writingAssignmentsServer.ts");

  assert.match(creationRoute, /create_category_writing_assignment_group/);
  assert.match(creationRoute, /categoryCreate/);
  assert.match(batchEditRoute, /update_withdrawn_category_assignment_group/);
  assert.match(form, /TeacherCategoryAssignmentConfig/);
  assert.match(form, /categoryAssignmentItemTypeForSubject/);
  assert.match(form, /categories: categoryValidation\.ok \? categoryValidation\.rows/);
  assert.match(form, /toggleAssignmentKind/);
  assert.doesNotMatch(form, /切换作业形式会清空当前题目配置/);
  assert.match(form, /seededCategoryAssignmentId/);
  assert.match(mutationServer, /hasMoreThanOneCategoryAssignmentValue/);
  assert.match(mutationServer, /prepareCategoryAssignmentItem\(supabase, value\)/);
  assert.match(categoryConfig, /合计：\{total\} 题/);
  assert.match(categoryConfig, /（可用 \{option\.count\} 题）/);
  assert.match(categoryConfig, /appearance-none pr-10/);
  assert.match(categoryConfig, /right-3 top-1\/2/);
  assert.doesNotMatch(categoryConfig, /categoryAssignmentSummary/);
  assert.doesNotMatch(categoryConfig, /当前分类题库可用 \{available\} 题/);
  const teacherList = read("components/teacher/TeacherWritingAssignmentList.tsx");
  const studentAssignments = read("components/student/StudentWritingAssignments.tsx");
  for (const card of [teacherList, studentAssignments]) {
    assert.match(card, /writingAssignmentCardTaskTypeBadges/);
    assert.doesNotMatch(card, /category_summary/);
    assert.doesNotMatch(card, /共 \{assignment\.category_total_questions\} 题/);
  }
  assert.match(server, /drawBasCategoryAssignmentManifest/);
  assert.match(server, /drawRapCategoryAssignmentManifest/);
  assert.match(server, /usedSentences/);
  assert.match(grammarPractice, /startGrammarCategoryAssignmentSession/);
  assert.doesNotMatch(grammarPractice, /allowPause=/);
  assert.match(grammarPractice, /timed=\{!positiveTimer\}/);
  assert.match(categoryPractice, /startCategoryAssignmentSession/);
  assert.match(practiceSession, /allowPause/);
  assert.match(practiceSession, /timerPaused/);
  assert.match(assignmentResults, /bas_grammar_practice_sessions/);
  assert.match(assignmentResults, /reading_question_category_sessions/);
  assert.doesNotMatch(server, /practice_entitlement_spend_category/);
  assert.doesNotMatch(form, /410/);
});
