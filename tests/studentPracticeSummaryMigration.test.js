const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const sql = read("supabase/student_practice_summary.sql");

function functionBody(name) {
  const pattern = new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$;`,
    "i"
  );
  return sql.match(pattern)?.[0] ?? "";
}

function triggerBlock(name) {
  const pattern = new RegExp(
    `create trigger ${name}[\\s\\S]*?execute function public\\.[a-z_]+\\(\\);`,
    "i"
  );
  return sql.match(pattern)?.[0] ?? "";
}

test("summary table schema, RLS, and grants match the agreed design", () => {
  assert.match(sql, /create table if not exists public\.student_practice_summary/);
  assert.match(sql, /student_id uuid primary key references public\.profiles\(id\)/);
  assert.match(sql, /on delete cascade/);
  assert.match(sql, /total_practice_seconds bigint not null default 0 check \(total_practice_seconds >= 0\)/);
  assert.match(sql, /latest_practice_at timestamptz/);
  assert.match(sql, /updated_at timestamptz not null default clock_timestamp\(\)/);
  assert.match(sql, /alter table public\.student_practice_summary enable row level security/);
  assert.doesNotMatch(sql, /create policy/i);
  assert.match(sql, /revoke all on table public\.student_practice_summary from public, anon, authenticated/);
  assert.match(sql, /grant select, insert, update, delete on table public\.student_practice_summary to service_role/);
  assert.doesNotMatch(sql, /student_practice_summary_student_idx/);
});

test("increment function adds duration once and handles NULL latest timestamps explicitly", () => {
  const body = functionBody("apply_student_practice_summary_increment");
  assert.ok(body.length > 0, "increment function must exist");
  assert.match(body, /greatest\(coalesce\(p_duration_seconds, 0\), 0\)/);
  assert.match(body, /summary\.total_practice_seconds \+ v_duration/);
  assert.match(body, /when p_completed_at is null then summary\.latest_practice_at/);
  assert.match(body, /when summary\.latest_practice_at is null then p_completed_at/);
  assert.match(body, /else greatest\(summary\.latest_practice_at, p_completed_at\)/);
  assert.doesNotMatch(body, /total_practice_seconds - /);
});

test("Reading and Reading wrongbook only accumulate on draft to submitted", () => {
  for (const name of [
    "trg_reading_attempts_student_practice_summary",
    "trg_reading_wrongbook_student_practice_summary"
  ]) {
    const block = triggerBlock(name);
    assert.ok(block.length > 0, `${name} must exist`);
    assert.match(block, /after update on public\.(reading_attempts|reading_wrongbook_attempts)/);
    assert.match(block, /old\.status = 'draft'/);
    assert.match(block, /new\.status = 'submitted'/);
    assert.match(block, /new\.submitted_at is not null/);
  }
  const body = functionBody("sync_student_practice_summary_reading");
  assert.match(body, /greatest\(coalesce\(new\.elapsed_seconds, 0\), 0\)/);
  assert.equal((body.match(/perform public\.apply_student_practice_summary_increment/g) ?? []).length, 1);
});

test("Writing only accumulates on draft to submitted", () => {
  const block = triggerBlock("trg_writing_attempts_student_practice_summary");
  assert.ok(block.length > 0, "writing trigger must exist");
  assert.match(block, /after update on public\.writing_attempts/);
  assert.match(block, /old\.status = 'draft'/);
  assert.match(block, /new\.status = 'submitted'/);
  assert.match(block, /new\.submitted_at is not null/);
  const body = functionBody("sync_student_practice_summary_writing");
  assert.match(body, /new\.user_id/);
  assert.match(body, /greatest\(coalesce\(new\.elapsed_seconds, 0\), 0\)/);
  assert.equal((body.match(/perform public\.apply_student_practice_summary_increment/g) ?? []).length, 1);
});

test("BAS attempts insert accumulates and re-submitted updates never double count", () => {
  const insertBlock = triggerBlock("trg_attempts_student_practice_summary_insert");
  assert.ok(insertBlock.length > 0, "attempts insert trigger must exist");
  assert.match(insertBlock, /after insert on public\.attempts/);
  assert.match(insertBlock, /when \(new\.submitted_at is not null\)/);
  const insertBody = functionBody("sync_student_practice_summary_attempts_insert");
  assert.match(insertBody, /new\.student_id/);
  assert.match(insertBody, /greatest\(coalesce\(new\.time_spent_seconds, 0\), 0\)/);
  assert.equal((insertBody.match(/perform public\.apply_student_practice_summary_increment/g) ?? []).length, 1);

  // There is no AFTER UPDATE trigger on attempts, so submitted rows can never
  // accumulate twice.
  assert.doesNotMatch(sql, /after update on public\.attempts/);
});

test("Full Set completion only updates the timestamp", () => {
  const block = triggerBlock("trg_reading_full_set_student_practice_summary");
  assert.ok(block.length > 0, "full set trigger must exist");
  assert.match(block, /after update on public\.reading_full_set_attempts/);
  assert.match(block, /old\.status is distinct from 'completed'/);
  assert.match(block, /new\.status = 'completed'/);
  assert.match(block, /new\.completed_at is not null/);
  const body = functionBody("sync_student_practice_summary_full_set");
  assert.match(body, /new\.student_id,\s*0,\s*new\.completed_at/);
});

test("attempts DELETE rebuilds one student from the five source tables", () => {
  const block = triggerBlock("trg_attempts_student_practice_summary_delete");
  assert.ok(block.length > 0, "attempts delete trigger must exist");
  assert.match(block, /after delete on public\.attempts/);
  assert.match(block, /when \(old\.submitted_at is not null\)/);
  const deleteBody = functionBody("sync_student_practice_summary_attempts_delete");
  assert.match(deleteBody, /perform public\.rebuild_student_practice_summary\(old\.student_id\)/);

  const rebuildBody = functionBody("rebuild_student_practice_summary");
  assert.match(rebuildBody, /from public\.reading_attempts/);
  assert.match(rebuildBody, /from public\.reading_wrongbook_attempts/);
  assert.match(rebuildBody, /from public\.attempts/);
  assert.match(rebuildBody, /from public\.writing_attempts/);
  assert.match(rebuildBody, /from public\.reading_full_set_attempts/);
  assert.match(rebuildBody, /status = 'submitted'/);
  assert.match(rebuildBody, /submitted_at is not null/);
  assert.match(rebuildBody, /status = 'completed'/);
  assert.match(rebuildBody, /set total_practice_seconds = excluded\.total_practice_seconds/);
  assert.doesNotMatch(rebuildBody, /total_practice_seconds \+ /);
});

test("initialization is atomic: lock, then backfill, then triggers", () => {
  const lockIndex = sql.indexOf("in share row exclusive mode");
  const backfillIndex = sql.indexOf("-- Backfill: overwrite each student row");
  const triggerIndex = sql.indexOf("-- Enable incremental maintenance only after the snapshot is complete");
  assert.ok(lockIndex > 0, "lock statement must exist");
  assert.ok(backfillIndex > lockIndex, "backfill must run after the lock");
  assert.ok(triggerIndex > backfillIndex, "triggers must be created after the backfill");
  for (const table of [
    "public.reading_attempts",
    "public.reading_wrongbook_attempts",
    "public.attempts",
    "public.writing_attempts",
    "public.reading_full_set_attempts"
  ]) {
    const lockStatement = sql.slice(sql.indexOf("lock table"), lockIndex);
    assert.ok(lockStatement.includes(table), `${table} must be locked`);
  }
});

test("backfill is an idempotent overwrite and aborts on any mismatch", () => {
  const backfill = sql.slice(
    sql.indexOf("-- Backfill: overwrite each student row"),
    sql.indexOf("-- Enable incremental maintenance only after the snapshot is complete")
  );
  assert.match(backfill, /on conflict \(student_id\) do update/);
  assert.match(backfill, /set total_practice_seconds = excluded\.total_practice_seconds/);
  assert.match(backfill, /latest_practice_at = excluded\.latest_practice_at/);
  assert.doesNotMatch(backfill, /total_practice_seconds \+ /);
  assert.match(sql, /raise exception 'student_practice_summary initialization mismatch/);
  assert.match(sql, /full join public\.student_practice_summary summary/);
});

test("functions and triggers are SECURITY DEFINER and revoked from clients", () => {
  const functionCount = (sql.match(/security definer/gi) ?? []).length;
  assert.ok(functionCount >= 7, "all summary functions must be security definer");
  assert.ok((sql.match(/set search_path = public/g) ?? []).length >= 7);
  assert.match(sql, /revoke all on function public\.apply_student_practice_summary_increment\(uuid, bigint, timestamptz\) from public, anon, authenticated/);
  assert.match(sql, /revoke all on function public\.rebuild_student_practice_summary\(uuid\) from public, anon, authenticated/);
  for (const name of [
    "sync_student_practice_summary_reading",
    "sync_student_practice_summary_attempts_insert",
    "sync_student_practice_summary_attempts_delete",
    "sync_student_practice_summary_writing",
    "sync_student_practice_summary_full_set"
  ]) {
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${name}\\(\\) from public, anon, authenticated`)
    );
  }
});

test("migration is re-runnable", () => {
  for (const name of [
    "trg_reading_attempts_student_practice_summary",
    "trg_reading_wrongbook_student_practice_summary",
    "trg_attempts_student_practice_summary_insert",
    "trg_attempts_student_practice_summary_delete",
    "trg_writing_attempts_student_practice_summary",
    "trg_reading_full_set_student_practice_summary"
  ]) {
    assert.match(sql, new RegExp(`drop trigger if exists ${name} on public\\.`));
  }
  assert.ok((sql.match(/create or replace function/g) ?? []).length >= 7);
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
});

test("transactional trigger verification script is rollback-only and covers every check", () => {
  const script = read("supabase/student_practice_summary_trigger_verification.sql");
  assert.equal((script.match(/^begin;/gm) ?? []).length, 1);
  assert.equal((script.match(/^rollback;/gm) ?? []).length, 1);
  assert.doesNotMatch(script, /^commit;/m);
  const successIndex = script.indexOf("select 'ALL_CHECKS_PASSED' as result;");
  const rollbackIndex = script.indexOf("\nrollback;");
  assert.ok(successIndex > 0 && rollbackIndex > successIndex, "result row must precede rollback");
  for (const marker of [
    "T1 failed",
    "T2 failed",
    "T3 failed",
    "T3b failed",
    "T4 failed",
    "T4b failed",
    "T4c failed",
    "T5 failed",
    "T5b failed",
    "T6 failed",
    "T6b failed",
    "T7 failed",
    "T7b failed",
    "T8 failed",
    "T9a failed",
    "T9b failed",
    "T9c failed",
    "T9d failed",
    "T9e failed"
  ]) {
    assert.match(script, new RegExp(marker));
  }
  assert.match(script, /apply_student_practice_summary_increment/);
  assert.match(script, /rebuild_student_practice_summary/);
  assert.match(script, /insert into public\.attempts \(/);
  // Generated columns (e.g. attempts.accuracy) must never be written directly.
  assert.doesNotMatch(script, /accuracy/);
  assert.doesNotMatch(script, /jsonb_populate_record/);
});

test("verification script is read-only and compares against the old aggregation", () => {
  const script = read("scripts/verify-student-practice-summary.ts");
  assert.match(script, /student_practice_summary/);
  assert.match(script, /aggregateTeacherStudentPracticeSummaries/);
  assert.match(script, /reading_wrongbook_attempts/);
  assert.match(script, /reading_full_set_attempts/);
  assert.doesNotMatch(script, /\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/);
});
