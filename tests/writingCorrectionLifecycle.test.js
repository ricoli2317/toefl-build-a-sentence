import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createOrResumeWritingCorrection, mutateWritingCorrection, loadOwnedWritingCorrection,
  loadWritingCorrectionHistory } from "../lib/writingCorrection.server.ts";
import { correctionDatabaseError, frozenWritingCorrectionSource } from "../lib/writingCorrection.ts";
import { countEnglishWords } from "../lib/writing.ts";
import { moderateWritingReviewAttempts } from "../lib/writingReviewModeration.server.ts";
import { loadAuthorizedWritingReviewSource } from "../lib/writingReviewWorkspaceServer.ts";
import { cacheDomainsForEvent } from "../lib/cacheInvalidation.ts";

// In-memory RPC CONTRACT double, not a PostgreSQL implementation or SQL test.
// No credentials, network, real accounts, environment files or SQL execution.
const STUDENT = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const clone = (value) => structuredClone(value);
function fixture(task = "email", assignment = false) {
  const question = task === "email" ? {
    question_id: "q1", set_id: "s1", set_title: "Frozen title", year_month: "2026-11", source_labels: "",
    scenario: "Scenario", task_instruction: "Write", requirement_1: "One", requirement_2: "Two",
    requirement_3: "Three", closing_instruction: "Close", recipient: "Reader", subject: "Subject"
  } : {
    question_id: "q1", set_id: "s1", set_title: "Frozen title", year_month: "2026-11", source_labels: "",
    professor_name: "Professor", professor_prompt: "Prompt", student_1_name: "One",
    student_1_response: "Response one", student_2_name: "Two", student_2_response: "Response two"
  };
  const original = { attempt_id: PARENT, attempt_kind: "original", user_id: STUDENT,
    task_type: task, question_id: "q1", set_id: "s1", assignment_id: assignment ? OTHER : null,
    response_text: "Original response", word_count: 2, status: "submitted", draft_version: 0,
    submitted_at: "2026-11-01T00:00:00Z", writing_mode: "exam", time_limit_seconds: task === "email" ? 420 : 600,
    remaining_seconds: 1, elapsed_seconds: 10, overtime_ranges: [] };
  const db = { calls: [], active: true, published: true, gate: false, question,
    review: { review_id: OTHER, published_at: "2026-11-01T00:00:00Z", language_edits: [],
      content_feedback: { items: [], overall_feedback: "Feedback" }, scores: { total: 4 }, teacher_comment: "Original comment" },
    rows: { writing_attempts: [original], writing_assignments: assignment ? [{ assignment_id: OTHER, teacher_id: "teacher" }] : [],
      teacher_student_bindings: [{ teacher_id: "teacher", student_id: STUDENT, domain: "writing",
        student: { id: STUDENT, role: "student", is_active: true } }], profiles: [{ id: STUDENT, role: "student", is_active: true }] },
    reviewed: new Set() };
  const fail = (message) => ({ data: null, error: { code: "P0001", message } });
  let serial = Promise.resolve();
  db.rpc = (name, args) => {
    db.calls.push([name, clone(args)]);
    const work = serial.then(() => {
      if (!db.active) return fail("WRITING_CORRECTION_ACCOUNT_FORBIDDEN");
      if (name === "ignore_teacher_writing_corrections") return { data: args.p_attempt_ids.map(id => ({
        attempt_id: id, outcome: db.reviewed.has(id) ? "skipped" : "ignored", reason: db.reviewed.has(id) ? "already_reviewed" : null
      })), error: null };
      if (name === "moderate_teacher_writing_attempts") {
        const data = args.p_attempt_ids.map((id) => {
          const row = db.rows.writing_attempts.find((r) => r.attempt_id === id);
          let reason = !row ? "not_found" : row.status !== "submitted" ? "not_submitted"
            : db.reviewed.has(id) ? "already_reviewed"
              : db.rows.writing_attempts.some((r) => r.attempt_kind === "correction" && r.status === "draft"
                && r.original_attempt_id === row.original_attempt_id && r.attempt_id !== id) ? "draft_exists" : null;
          if (reason) return { attempt_id: id, outcome: "skipped", reason };
          if (db.gate) throw new Error("Gate result is tested separately");
          row.status = "draft"; row.submitted_at = null; row.draft_version++;
          return { attempt_id: id, outcome: "returned", reason: null };
        });
        return { data, error: null };
      }
      if (name === "create_or_resume_writing_correction") {
        const parent = db.rows.writing_attempts.find((r) => r.attempt_id === args.p_original_attempt && r.user_id === args.p_student);
        if (!parent) return fail("WRITING_CORRECTION_NOT_FOUND");
        if (parent.attempt_kind !== "original" || parent.status !== "submitted") return fail("WRITING_CORRECTION_ORIGINAL_MISMATCH");
        const draft = db.rows.writing_attempts.find((r) => r.original_attempt_id === parent.attempt_id && r.status === "draft");
        if (draft) return { data: { attempt: clone(draft), resumed: true }, error: null };
        if (!db.published) return fail("WRITING_CORRECTION_PUBLISHED_REVIEW_REQUIRED");
        if (db.gate) return fail("WRITING_CORRECTION_NOT_ENABLED");
        const row = { ...clone(parent), attempt_id: `44444444-4444-4444-8444-${String(db.rows.writing_attempts.length).padStart(12, "0")}`,
          attempt_kind: "correction", original_attempt_id: parent.attempt_id, status: "draft", submitted_at: null,
          draft_version: 0, writing_mode: null, elapsed_seconds: 0, remaining_seconds: parent.time_limit_seconds,
          correction_source_snapshot: { schema_version: 1, original_response_text: parent.response_text,
            original_context: clone(parent), question_source: assignment ? "custom" : "question_bank",
            question: clone(db.question), published_review: clone(db.review) } };
        db.rows.writing_attempts.push(row);
        return { data: { attempt: clone(row), resumed: false }, error: null };
      }
      const row = db.rows.writing_attempts.find((r) => r.attempt_id === args.p_attempt
        && r.user_id === args.p_student && r.attempt_kind === "correction");
      if (!row) return fail("WRITING_CORRECTION_NOT_FOUND");
      if (name === "submit_writing_correction" && row.status === "submitted") {
        return { data: { attempt: clone(row), alreadySubmitted: true }, error: null };
      }
      if (row.status !== "draft") return fail("WRITING_CORRECTION_SUBMITTED_LOCKED");
      if (row.draft_version !== args.p_expected_version) return fail("WRITING_CORRECTION_VERSION_CONFLICT");
      if (db.gate) return fail("WRITING_CORRECTION_NOT_ENABLED");
      if (name === "save_writing_correction_revision") {
        row.response_text = args.p_response_text; row.word_count = countEnglishWords(row.response_text);
        db.rows.writing_correction_revision_states ??= [];
        db.rows.writing_correction_revision_states = db.rows.writing_correction_revision_states.filter(r => r.attempt_id !== row.attempt_id);
        db.rows.writing_correction_revision_states.push({ attempt_id: row.attempt_id, revision_state: clone(args.p_revision_state), saved_draft_version: row.draft_version + 1 });
      } else { row.status = "submitted"; row.submitted_at = "2026-11-02T00:00:00Z"; }
      row.draft_version++;
      return { data: { attempt: clone(row), alreadySubmitted: false }, error: null };
    });
    serial = work.then(() => undefined, () => undefined);
    return work;
  };
  db.from = (table) => {
    let rows = [...(db.rows[table] ?? [])];
    const q = { select() { return q; }, order() { return q; },
      eq(key, value) { rows = rows.filter((r) => r[key] === value); return q; },
      in(key, values) { rows = rows.filter((r) => values.includes(r[key])); return q; },
      range(from, to) { rows = rows.slice(from, to + 1); return q; },
      maybeSingle() { return Promise.resolve({ data: rows[0] ? clone(rows[0]) : null, error: null }); },
      then(resolve) { return Promise.resolve({ data: clone(rows), error: null }).then(resolve); } };
    return q;
  };
  return db;
}
const start = (db, user = STUDENT, parent = PARENT) => createOrResumeWritingCorrection(db, user, { originalAttemptId: parent });
const mutate = (db, id, action, version, text) => mutateWritingCorrection(db, STUDENT, id,
  { action, expectedDraftVersion: version, ...(text === undefined ? {} : { responseText: text }) });
const rejects = (action, code, status) => assert.rejects(action, (e) => e.code === code && e.status === status);

for (const task of ["email", "academic_discussion"]) for (const assignment of [false, true]) {
  test(`${task}/${assignment ? "assignment" : "bank"}: lifecycle, snapshot freeze and recovery (mock RPC)`, async () => {
    const db = fixture(task, assignment);
    const first = await start(db); const id = first.attempt.attempt_id;
    const snapshot = clone(first.attempt.correction_source_snapshot);
    assert.equal(first.resumed, false);
    assert.equal(snapshot.question_source, assignment ? "custom" : "question_bank");
    assert.equal(first.attempt.writing_mode, null);
    assert.equal(first.attempt.elapsed_seconds, 0);
    assert.equal(first.attempt.remaining_seconds, first.attempt.time_limit_seconds);
    db.review.teacher_comment = "Republished"; db.published = false; db.question.set_title = "Changed";
    const save = await mutate(db, id, "save", 0, "Changed response");
    assert.equal(save.attempt.draft_version, 1);
    const resumed = await start(db);
    assert.equal(resumed.resumed, true); assert.equal(resumed.attempt.attempt_id, id);
    assert.equal(resumed.attempt.response_text, "Changed response");
    assert.deepEqual(resumed.attempt.correction_source_snapshot, snapshot);
    assert.equal(resumed.cacheInvalidation, null);
    const read = await loadOwnedWritingCorrection(db, STUDENT, id);
    assert.equal(read.question.set_title, "Frozen title");
    await rejects(() => mutate(db, id, "save", 0, "stale"), "WRITING_CORRECTION_VERSION_CONFLICT", 409);
    const submit = await mutate(db, id, "submit", 1);
    assert.equal(submit.attempt.status, "submitted"); assert.equal(submit.attempt.draft_version, 2);
    const retry = await mutate(db, id, "submit", 1);
    assert.equal(retry.alreadySubmitted, true); assert.equal(retry.cacheInvalidation, null);
    await rejects(() => mutate(db, id, "save", 2, "overwrite"), "WRITING_CORRECTION_SUBMITTED_LOCKED", 409);
    db.published = true;
    const next = await start(db);
    assert.notEqual(next.attempt.attempt_id, id); assert.equal(next.attempt.response_text, "Original response");
    const conflict = await moderateWritingReviewAttempts(db, { actor: { userId: "teacher", role: "teacher" }, action: "return", attemptIds: [id] });
    assert.equal(conflict[0].reason, "draft_exists");
    await mutate(db, next.attempt.attempt_id, "submit", 0);
    const returned = await moderateWritingReviewAttempts(db, { actor: { userId: "teacher", role: "teacher" }, action: "return", attemptIds: [id] });
    assert.equal(returned[0].outcome, "returned");
    const restored = await start(db);
    assert.equal(restored.attempt.attempt_id, id); assert.equal(restored.attempt.draft_version, 3);
    assert.deepEqual(restored.attempt.correction_source_snapshot, snapshot);
    assert.equal(db.rows.writing_attempts[0].status, "submitted");
    assert.equal((await loadWritingCorrectionHistory(db, STUDENT, PARENT)).attempts.length, 2);
  });
}

test("rejection boundaries and Gate error mapping (mock, no writes outside memory)", async () => {
  const db = fixture();
  db.published = false;
  await rejects(() => start(db), "WRITING_CORRECTION_PUBLISHED_REVIEW_REQUIRED", 409);
  await rejects(() => start(db, OTHER), "WRITING_CORRECTION_NOT_FOUND", 404);
  db.published = true; db.active = false;
  await rejects(() => start(db), "WRITING_CORRECTION_ACCOUNT_FORBIDDEN", 403);
  db.active = true; db.gate = true;
  await rejects(() => start(db), "WRITING_CORRECTION_NOT_ENABLED", 503);
  db.gate = false;
  const first = await start(db);
  await rejects(() => start(db, STUDENT, first.attempt.attempt_id), "WRITING_CORRECTION_ORIGINAL_MISMATCH", 409);
  await rejects(() => loadOwnedWritingCorrection(db, OTHER, first.attempt.attempt_id), "WRITING_CORRECTION_NOT_FOUND", 404);
  await rejects(() => loadWritingCorrectionHistory(db, OTHER, PARENT), "WRITING_CORRECTION_NOT_FOUND", 404);
  assert.equal(correctionDatabaseError({ code: "PGRST202" }).status, 503);
});

test("concurrent requests respect RPC result/CAS contract (serialized in-memory double, NOT database locking verification)", async () => {
  const db = fixture();
  const created = await Promise.all([start(db), start(db)]);
  assert.equal(created[0].attempt.attempt_id, created[1].attempt.attempt_id);
  const id = created[0].attempt.attempt_id;
  const saves = await Promise.allSettled([mutate(db, id, "save", 0, "First"), mutate(db, id, "save", 0, "Second")]);
  assert.equal(saves.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(saves.find((r) => r.status === "rejected").reason.status, 409);
  const submits = await Promise.all([mutate(db, id, "submit", 1), mutate(db, id, "submit", 1)]);
  assert.deepEqual(submits.map((r) => r.alreadySubmitted), [false, true]);
});

test("input whitelist prevents user/source/timer/version injection and forwards authenticated user only", async () => {
  const db = fixture();
  for (const key of ["user_id", "attempt_kind", "original_attempt_id", "correction_source_snapshot", "draft_version"]) {
    await rejects(() => createOrResumeWritingCorrection(db, STUDENT, { originalAttemptId: PARENT, [key]: OTHER }), "INVALID_INPUT", 400);
  }
  assert.equal(db.calls.length, 0);
  const { attempt } = await start(db);
  for (const version of [-1, "0", 0.5, null, Number.MAX_SAFE_INTEGER + 1]) {
    await rejects(() => mutate(db, attempt.attempt_id, "save", version, "Text"), "INVALID_INPUT", 400);
  }
  await rejects(() => mutate(db, attempt.attempt_id, "submit", 0, "unsaved"), "INVALID_INPUT", 400);
  await rejects(() => mutateWritingCorrection(db, STUDENT, attempt.attempt_id,
    { action: "save", expectedDraftVersion: 0, responseText: "Text", remainingSeconds: 0 }), "INVALID_INPUT", 400);
  assert.deepEqual(db.calls[0][1], { p_student: STUDENT, p_original_attempt: PARENT });
});

test("teacher scope is preserved; reviewed corrections cannot return; ordinary workspace/AI is blocked", async () => {
  const db = fixture(); const { attempt } = await start(db);
  await mutate(db, attempt.attempt_id, "submit", 0);
  const before = db.calls.length;
  const denied = await moderateWritingReviewAttempts(db, { actor: { userId: "other-teacher", role: "teacher" },
    action: "return", attemptIds: [attempt.attempt_id] });
  assert.equal(denied[0].reason, "not_found"); assert.equal(db.calls.length, before);
  db.reviewed.add(attempt.attempt_id);
  const reviewed = await moderateWritingReviewAttempts(db, { actor: { userId: "teacher", role: "teacher" },
    action: "return", attemptIds: [attempt.attempt_id] });
  assert.equal(reviewed[0].reason, "already_reviewed");
  await rejects(() => loadAuthorizedWritingReviewSource(db, { userId: "teacher", role: "teacher" }, attempt.attempt_id),
    "CORRECTION_REVIEW_NOT_SUPPORTED", 409);
  const source = await loadAuthorizedWritingReviewSource(db, { userId: "teacher", role: "teacher" },
    attempt.attempt_id, { allowCorrectionSource: true });
  assert.equal(frozenWritingCorrectionSource(source.attempt).question.set_title, "Frozen title");
  const ignored = await moderateWritingReviewAttempts(db, { actor: { userId: "teacher", role: "teacher" },
    action: "ignore", attemptIds: [attempt.attempt_id] });
  assert.equal(ignored[0].reason, "already_reviewed");
  assert.equal(db.calls.at(-1)[0], "ignore_teacher_writing_corrections");
});

test("correction cache events never invalidate ordinary state/history/assignments/published review", () => {
  for (const type of ["WRITING_CORRECTION_UPDATED", "WRITING_ATTEMPT_SUBMITTED", "WRITING_ATTEMPT_RETURNED"]) {
    const domains = cacheDomainsForEvent({ type, attemptKind: "correction", assignmentId: OTHER });
    assert.deepEqual(domains, ["studentWritingCorrections", "teacherWritingReviews", "teacherWritingReviewWorkspace"]);
  }
  assert.ok(cacheDomainsForEvent({ type: "WRITING_ATTEMPT_SUBMITTED", assignmentId: OTHER }).includes("studentAssignments"));
});

test("SQL contracts are additive and leave Gate untouched (STATIC, not SQL execution)", () => {
  const sql = readFileSync(new URL("../supabase/writing_correction_phase1b/20_writing_correction_phase1b.sql", import.meta.url), "utf8");
  assert.equal((sql.match(/CREATE FUNCTION public\./g) ?? []).length, 3);
  assert.doesNotMatch(sql, /(?:DISABLE\s+TRIGGER|DROP\s+TRIGGER|ALTER\s+TABLE|CREATE OR REPLACE)/i);
  assert.doesNotMatch(sql, /SET\s+draft_version\s*=/i);
  assert.match(sql, /AND user_id=p_student FOR UPDATE/);
  assert.match(sql, /status='published'.*published_at IS NOT NULL FOR SHARE/);
  assert.match(sql, /draft_version=p_expected_version RETURNING/);
  assert.match(sql, /FROM PUBLIC,anon,authenticated/);
  assert.match(sql, /TO service_role/);
});
