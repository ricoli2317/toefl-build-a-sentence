const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");

const MODERATION_SQL = fs.readFileSync(
  "supabase/writing_review_return_existing_draft_v1.sql",
  "utf8"
);
const GUARD_SQL = fs.readFileSync(
  "supabase/writing_review_return_entitlement_guard_v1.sql",
  "utf8"
);

const STUDENT = "11111111-1111-4111-8111-111111111111";
const ITEM = "99999999-9999-4999-8999-999999999999";
const SUBMITTED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const NORMAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const DRAFT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;

    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
      SELECT coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
      )::text
    $$;

    CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text, is_active boolean);
    CREATE TABLE public.writing_assignments (
      assignment_id uuid PRIMARY KEY,
      status text,
      deleted_at timestamptz,
      task_type text,
      question_source text,
      question_id text,
      question_snapshot jsonb
    );
    CREATE TABLE public.writing_assignment_students (assignment_id uuid, student_id uuid);
    CREATE TABLE public.student_practice_unlocks (student_id uuid, task_type text, item_id text);
    CREATE TABLE public.student_practice_item_state (
      student_id uuid,
      task_type text,
      item_id text,
      status text,
      resume_attempt_id uuid,
      resume_source_question_id text,
      latest_attempt_id uuid,
      latest_completed_attempt_id uuid,
      attempt_count integer,
      last_started_at timestamptz,
      last_completed_at timestamptz,
      latest_result jsonb,
      updated_at timestamptz,
      PRIMARY KEY (student_id, task_type, item_id)
    );

    CREATE FUNCTION public.practice_entitlement_enforcement_enabled() RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION public.practice_entitlement_resolve_item(text, text, text, text) RETURNS text
      LANGUAGE sql STABLE AS $$ SELECT '${ITEM}'::text $$;
    CREATE FUNCTION public.practice_entitlement_has_prior_attempt(uuid, text, text, text) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION public.practice_entitlement_ensure_unlock(uuid, text, text, text, uuid, text) RETURNS boolean
      LANGUAGE sql AS $$ SELECT true $$;
    CREATE FUNCTION public.practice_entitlement_spend_and_unlock(uuid, text, text, text, uuid, text) RETURNS integer
      LANGUAGE sql AS $$ SELECT 0 $$;
    CREATE FUNCTION public.practice_item_is_public(uuid, text) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE FUNCTION public.writing_attempt_matches_item(text, uuid, text) RETURNS boolean
      LANGUAGE sql STABLE AS $$ SELECT true $$;

    CREATE TABLE public.writing_attempts (
      attempt_id uuid PRIMARY KEY,
      attempt_kind text NOT NULL,
      original_attempt_id uuid,
      correction_source_snapshot jsonb,
      draft_version bigint NOT NULL DEFAULT 0,
      assignment_id uuid,
      user_id uuid NOT NULL,
      task_type text NOT NULL,
      question_id text NOT NULL,
      set_id text NOT NULL,
      response_text text NOT NULL DEFAULT '',
      word_count integer NOT NULL DEFAULT 0,
      status text NOT NULL,
      writing_mode text,
      time_limit_seconds integer NOT NULL DEFAULT 600,
      remaining_seconds integer NOT NULL DEFAULT 600,
      elapsed_seconds integer,
      overtime_ranges jsonb NOT NULL DEFAULT '[]'::jsonb,
      started_at timestamptz NOT NULL DEFAULT now(),
      saved_at timestamptz,
      submitted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT writing_attempts_status_check CHECK (status IN ('draft', 'submitted'))
    );
    CREATE UNIQUE INDEX writing_attempts_one_draft_per_question
      ON public.writing_attempts(user_id, task_type, question_id)
      WHERE status = 'draft' AND assignment_id IS NULL AND attempt_kind = 'original';
    CREATE UNIQUE INDEX writing_attempts_one_assignment_draft
      ON public.writing_attempts(user_id, assignment_id)
      WHERE status = 'draft' AND assignment_id IS NOT NULL AND attempt_kind = 'original';
    CREATE UNIQUE INDEX writing_attempts_one_correction_draft
      ON public.writing_attempts(original_attempt_id)
      WHERE status = 'draft' AND attempt_kind = 'correction';

    CREATE TABLE public.writing_reviews (
      review_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      attempt_id uuid NOT NULL,
      task_type text NOT NULL,
      status text NOT NULL DEFAULT 'reviewing',
      ai_model text,
      ai_generated_at timestamptz,
      ai_review_raw jsonb,
      language_edits jsonb NOT NULL DEFAULT '[]'::jsonb,
      scores jsonb NOT NULL DEFAULT '{}'::jsonb,
      content_feedback jsonb NOT NULL DEFAULT '{"items":[],"overall_feedback":""}'::jsonb,
      teacher_comment text NOT NULL DEFAULT '',
      published_at timestamptz,
      CONSTRAINT writing_reviews_attempt_unique UNIQUE (attempt_id)
    );
  `);
  await db.exec(MODERATION_SQL);
  await db.exec(GUARD_SQL);
  await db.query("INSERT INTO public.profiles VALUES ($1, 'student', true)", [STUDENT]);
  await db.query(`SELECT set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
  return db;
}

async function insertAttempt(db, { attemptId, status, submittedAt = null }) {
  await db.query(
    `INSERT INTO public.writing_attempts (
       attempt_id, attempt_kind, user_id, task_type, question_id, set_id,
       status, writing_mode, submitted_at
     ) VALUES ($1, 'original', $2, 'academic_discussion', 'Q1', 'Q1', $3, 'practice', $4)`,
    [attemptId, STUDENT, status, submittedAt]
  );
}

async function returnAttempt(db, attemptId) {
  const result = await db.query(
    "SELECT * FROM public.moderate_teacher_writing_attempts('return', ARRAY[$1::uuid])",
    [attemptId]
  );
  return result.rows[0];
}

test("teacher return is allowed through the entitlement guard for service_role", async () => {
  const db = await createDatabase();
  try {
    await insertAttempt(db, {
      attemptId: SUBMITTED,
      status: "submitted",
      submittedAt: new Date().toISOString()
    });
    await insertAttempt(db, { attemptId: DRAFT, status: "draft" });

    const result = await returnAttempt(db, SUBMITTED);
    assert.equal(result.outcome, "returned");
    assert.equal(result.reason, null);

    const submittedRow = await db.query(
      "SELECT status, submitted_at FROM public.writing_attempts WHERE attempt_id = $1",
      [SUBMITTED]
    );
    assert.equal(submittedRow.rows[0].status, "returned");
    assert.notEqual(submittedRow.rows[0].submitted_at, null);

    const draftRow = await db.query(
      "SELECT status FROM public.writing_attempts WHERE attempt_id = $1",
      [DRAFT]
    );
    assert.equal(draftRow.rows[0].status, "draft");
  } finally {
    await db.close();
  }
});

test("normal return also passes the entitlement guard for service_role", async () => {
  const db = await createDatabase();
  try {
    await insertAttempt(db, {
      attemptId: NORMAL,
      status: "submitted",
      submittedAt: new Date().toISOString()
    });

    const result = await returnAttempt(db, NORMAL);
    assert.equal(result.outcome, "returned");
    assert.equal(result.reason, null);
    const row = await db.query(
      "SELECT status, submitted_at FROM public.writing_attempts WHERE attempt_id = $1",
      [NORMAL]
    );
    assert.equal(row.rows[0].status, "draft");
    assert.equal(row.rows[0].submitted_at, null);
  } finally {
    await db.close();
  }
});

test("the same return is still blocked for an authenticated student", async () => {
  const db = await createDatabase();
  try {
    await insertAttempt(db, {
      attemptId: NORMAL,
      status: "submitted",
      submittedAt: new Date().toISOString()
    });
    await db.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', false)`);

    await assert.rejects(
      () => returnAttempt(db, NORMAL),
      /WRITING_ATTEMPT_STATUS_IMMUTABLE/
    );
    const row = await db.query(
      "SELECT status FROM public.writing_attempts WHERE attempt_id = $1",
      [NORMAL]
    );
    assert.equal(row.rows[0].status, "submitted");
  } finally {
    await db.close();
  }
});

test("a student cannot set the terminal returned status directly", async () => {
  const db = await createDatabase();
  try {
    await insertAttempt(db, {
      attemptId: NORMAL,
      status: "submitted",
      submittedAt: new Date().toISOString()
    });
    await db.query(`SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', false)`);

    await assert.rejects(
      () => db.query(
        "UPDATE public.writing_attempts SET status = 'returned' WHERE attempt_id = $1",
        [NORMAL]
      ),
      /WRITING_ATTEMPT_STATUS_IMMUTABLE/
    );
    const row = await db.query(
      "SELECT status FROM public.writing_attempts WHERE attempt_id = $1",
      [NORMAL]
    );
    assert.equal(row.rows[0].status, "submitted");
  } finally {
    await db.close();
  }
});

test("the practice state rebuild ignores the archived returned row", async () => {
  const db = await createDatabase();
  try {
    await insertAttempt(db, {
      attemptId: SUBMITTED,
      status: "submitted",
      submittedAt: new Date().toISOString()
    });
    await insertAttempt(db, { attemptId: DRAFT, status: "draft" });
    await returnAttempt(db, SUBMITTED);

    await db.query(
      "SELECT public.rebuild_student_practice_item_state_writing($1, 'academic_discussion', $2::uuid)",
      [STUDENT, ITEM]
    );
    const state = await db.query(
      "SELECT status, resume_attempt_id, latest_attempt_id, latest_completed_attempt_id FROM public.student_practice_item_state"
    );
    assert.equal(state.rows[0].status, "in_progress");
    assert.equal(state.rows[0].resume_attempt_id, DRAFT);
    assert.equal(state.rows[0].latest_attempt_id, DRAFT);
    assert.equal(state.rows[0].latest_completed_attempt_id, null);
  } finally {
    await db.close();
  }
});

test("a rebuild with only archived returned rows removes the stale state row", async () => {
  const db = await createDatabase();
  try {
    await insertAttempt(db, {
      attemptId: SUBMITTED,
      status: "returned",
      submittedAt: new Date().toISOString()
    });
    await db.query(
      `INSERT INTO public.student_practice_item_state (
         student_id, task_type, item_id, status, attempt_count
       ) VALUES ($1, 'academic_discussion', $2, 'completed', 1)`,
      [STUDENT, ITEM]
    );

    await db.query(
      "SELECT public.rebuild_student_practice_item_state_writing($1, 'academic_discussion', $2::uuid)",
      [STUDENT, ITEM]
    );
    const state = await db.query(
      "SELECT count(*)::int AS n FROM public.student_practice_item_state"
    );
    assert.equal(state.rows[0].n, 0);
  } finally {
    await db.close();
  }
});
