const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { PGlite } = require("@electric-sql/pglite");

const SQL = fs.readFileSync(
  "supabase/writing_review_return_existing_draft_v1.sql",
  "utf8"
);

const STUDENT = "11111111-1111-4111-8111-111111111111";
const TEACHER = "22222222-2222-4222-8222-222222222222";
const ASSIGNMENT = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_NORMAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ATTEMPT_CONFLICT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const DRAFT_CONFLICT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const ATTEMPT_ASSIGNMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const DRAFT_ASSIGNMENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5";
const ATTEMPT_REVIEWED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6";
const ATTEMPT_IGNORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7";

async function createDatabase() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;

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
      CONSTRAINT writing_attempts_status_check
        CHECK (status IN ('draft', 'submitted'))
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
  await db.exec(SQL);
  return db;
}

async function insertAttempt(db, row) {
  await db.query(
    `INSERT INTO public.writing_attempts (
       attempt_id, attempt_kind, assignment_id, user_id, task_type, question_id,
       set_id, response_text, word_count, status, writing_mode,
       time_limit_seconds, remaining_seconds, elapsed_seconds, saved_at, submitted_at
     ) VALUES (
       $1, 'original', $2, $3, 'academic_discussion', $4, $4, '', 0, $5, $6,
       600, $7, 10, now(), $8
     )`,
    [
      row.attempt_id,
      row.assignment_id ?? null,
      STUDENT,
      row.question_id ?? "AD-TEST-1",
      row.status,
      row.writing_mode ?? "practice",
      row.remaining_seconds ?? 600,
      row.submitted_at === null ? null : (row.submitted_at ?? new Date().toISOString())
    ]
  );
}

async function returnAttempt(db, id) {
  const result = await db.query(
    "SELECT * FROM public.moderate_teacher_writing_attempts('return', ARRAY[$1::uuid])",
    [id]
  );
  return result.rows[0];
}

async function readAttempt(db, id) {
  const result = await db.query(
    "SELECT * FROM public.writing_attempts WHERE attempt_id = $1",
    [id]
  );
  return result.rows[0];
}

test("退回 with no newer draft still restores the submitted attempt as a draft", async () => {
  const db = await createDatabase();
  try {
    await insertAttempt(db, {
      attempt_id: ATTEMPT_NORMAL,
      status: "submitted",
      writing_mode: "exam",
      remaining_seconds: 4
    });

    const result = await returnAttempt(db, ATTEMPT_NORMAL);
    assert.equal(result.outcome, "returned");
    assert.equal(result.reason, null);

    const row = await readAttempt(db, ATTEMPT_NORMAL);
    assert.equal(row.status, "draft");
    assert.equal(row.submitted_at, null);
    assert.equal(row.remaining_seconds, 600);
  } finally {
    await db.close();
  }
});

test("退回 keeps a newer self-practice draft and archives the old submission", async () => {
  const db = await createDatabase();
  try {
    await insertAttempt(db, { attempt_id: ATTEMPT_CONFLICT, status: "submitted" });
    const submittedAt = (await readAttempt(db, ATTEMPT_CONFLICT)).submitted_at;

    await insertAttempt(db, {
      attempt_id: DRAFT_CONFLICT,
      status: "draft",
      question_id: "AD-TEST-1",
      submitted_at: null
    });

    const result = await returnAttempt(db, ATTEMPT_CONFLICT);
    assert.equal(result.outcome, "returned");
    assert.equal(result.reason, null);

    const archived = await readAttempt(db, ATTEMPT_CONFLICT);
    assert.equal(archived.status, "returned");
    assert.equal(archived.submitted_at.toISOString(), submittedAt.toISOString());

    const draft = await readAttempt(db, DRAFT_CONFLICT);
    assert.equal(draft.status, "draft");

    const repeated = await returnAttempt(db, ATTEMPT_CONFLICT);
    assert.deepEqual(repeated, {
      attempt_id: ATTEMPT_CONFLICT,
      outcome: "skipped",
      reason: "not_submitted"
    });
  } finally {
    await db.close();
  }
});

test("退回 applies the same archive rule to assigned homework", async () => {
  const db = await createDatabase();
  try {
    await insertAttempt(db, {
      attempt_id: ATTEMPT_ASSIGNMENT,
      assignment_id: ASSIGNMENT,
      status: "submitted"
    });
    await insertAttempt(db, {
      attempt_id: DRAFT_ASSIGNMENT,
      assignment_id: ASSIGNMENT,
      status: "draft",
      submitted_at: null
    });

    const result = await returnAttempt(db, ATTEMPT_ASSIGNMENT);
    assert.equal(result.outcome, "returned");
    assert.equal((await readAttempt(db, ATTEMPT_ASSIGNMENT)).status, "returned");
    assert.equal((await readAttempt(db, DRAFT_ASSIGNMENT)).status, "draft");
  } finally {
    await db.close();
  }
});

test("退回 is refused once review work exists", async () => {
  const db = await createDatabase();
  try {
    await insertAttempt(db, { attempt_id: ATTEMPT_REVIEWED, status: "submitted" });
    await db.query(
      `INSERT INTO public.writing_reviews (attempt_id, task_type, status)
       VALUES ($1, 'academic_discussion', 'published')`,
      [ATTEMPT_REVIEWED]
    );

    const result = await returnAttempt(db, ATTEMPT_REVIEWED);
    assert.deepEqual(result, {
      attempt_id: ATTEMPT_REVIEWED,
      outcome: "skipped",
      reason: "already_reviewed"
    });
    assert.equal((await readAttempt(db, ATTEMPT_REVIEWED)).status, "submitted");
  } finally {
    await db.close();
  }
});

test("without the returned status, the RPC reports the conflict instead of failing", async () => {
  const db = await createDatabase();
  try {
    // Simulate an application deploy that reached the RPC before the status
    // constraint migration.
    await db.exec(`
      ALTER TABLE public.writing_attempts
        DROP CONSTRAINT writing_attempts_status_check;
      ALTER TABLE public.writing_attempts
        ADD CONSTRAINT writing_attempts_status_check
        CHECK (status IN ('draft', 'submitted'));
    `);
    await insertAttempt(db, { attempt_id: ATTEMPT_CONFLICT, status: "submitted" });
    await insertAttempt(db, {
      attempt_id: DRAFT_CONFLICT,
      status: "draft",
      submitted_at: null
    });

    const result = await returnAttempt(db, ATTEMPT_CONFLICT);
    assert.deepEqual(result, {
      attempt_id: ATTEMPT_CONFLICT,
      outcome: "skipped",
      reason: "draft_exists"
    });
    assert.equal((await readAttempt(db, ATTEMPT_CONFLICT)).status, "submitted");
  } finally {
    await db.close();
  }
});

test("忽略 keeps its existing lifecycle", async () => {
  const db = await createDatabase();
  try {
    await insertAttempt(db, { attempt_id: ATTEMPT_IGNORE, status: "submitted" });
    const result = await db.query(
      "SELECT * FROM public.moderate_teacher_writing_attempts('ignore', ARRAY[$1::uuid])",
      [ATTEMPT_IGNORE]
    );
    assert.equal(result.rows[0].outcome, "ignored");
    assert.equal((await readAttempt(db, ATTEMPT_IGNORE)).status, "submitted");
    const review = await db.query(
      "SELECT status FROM public.writing_reviews WHERE attempt_id = $1",
      [ATTEMPT_IGNORE]
    );
    assert.equal(review.rows[0].status, "ignored");
  } finally {
    await db.close();
  }
});

