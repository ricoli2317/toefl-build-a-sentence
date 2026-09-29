const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const sql = read("supabase/student_practice_item_state.sql");
const verify = read("supabase/student_practice_item_state_verify.sql");
const triggerVerify = read("supabase/student_practice_item_state_trigger_verification.sql");

test("migration SQL is well-formed and single-transaction", () => {
  // Every dollar-quoted body must be closed; an odd count means a truncated
  // function definition.
  assert.equal((sql.match(/\$\$/g) ?? []).length % 2, 0);
  const functionBodies = sql.match(/create or replace function[\s\S]*?\$\$;/g) ?? [];
  assert.ok(functionBodies.length >= 20);
  assert.ok(functionBodies.every((body) => body.trimEnd().endsWith("$$;")));
  assert.equal((sql.match(/^begin;/gm) ?? []).length, 1);
  assert.equal((sql.match(/^commit;/gm) ?? []).length, 1);
  assert.equal((triggerVerify.match(/\$\$/g) ?? []).length % 2, 0);
  assert.equal((verify.match(/\$\$/g) ?? []).length, 0, "the parity file is plain queries only");
});

test("state table is sparse, keyed per student+task+item, and service-role only", () => {
  assert.match(sql, /create table if not exists public\.student_practice_item_state/);
  assert.match(sql, /student_id uuid not null references public\.profiles\(id\) on delete cascade/);
  assert.match(sql, /task_type text not null check \(task_type in \(/);
  assert.match(sql, /item_id text not null check \(nullif\(btrim\(item_id\), ''\) is not null\)/);
  assert.match(sql, /check \(status in \('unstarted', 'in_progress', 'completed'\)\)/);
  assert.match(
    sql,
    /primary key \(student_id, task_type, item_id\)/
  );
  assert.match(sql, /resume_attempt_id uuid/);
  assert.match(sql, /resume_source_question_id text/);
  assert.match(sql, /latest_attempt_id uuid/);
  assert.match(sql, /latest_completed_attempt_id uuid/);
  assert.match(sql, /attempt_count integer not null default 0/);
  assert.match(sql, /last_started_at timestamptz/);
  assert.match(sql, /last_completed_at timestamptz/);
  assert.match(sql, /latest_result jsonb/);
  assert.match(sql, /alter table public\.student_practice_item_state enable row level security/);
  assert.doesNotMatch(sql, /create policy/i);
  assert.match(sql, /revoke all on table public\.student_practice_item_state from public, anon, authenticated/);
  assert.match(sql, /grant select, insert, update, delete on table public\.student_practice_item_state to service_role/);
});

test("every write path rebuilds only the affected student+item", () => {
  for (const trigger of [
    "trg_attempts_student_practice_item_state",
    "trg_writing_attempts_student_practice_item_state",
    "trg_reading_attempts_student_practice_item_state",
    "trg_reading_full_set_student_practice_item_state",
    "trg_practice_item_sources_student_practice_item_state",
    "trg_practice_items_student_practice_item_state"
  ]) {
    assert.match(sql, new RegExp(`drop trigger if exists ${trigger} on public\\.`));
    assert.match(sql, new RegExp(`create trigger ${trigger}`));
  }
  assert.match(sql, /after insert or update or delete on public\.attempts/);
  assert.match(sql, /after insert or update or delete on public\.writing_attempts/);
  assert.match(sql, /after insert or update or delete on public\.reading_attempts/);
  assert.match(sql, /after insert or update or delete on public\.reading_full_set_attempts/);
  assert.match(sql, /rebuild_student_practice_item_state_bas/);
  assert.match(sql, /rebuild_student_practice_item_state_writing/);
  assert.match(sql, /rebuild_student_practice_item_state_reading/);
  assert.match(sql, /rebuild_student_practice_item_state_full_set/);
  // No student-wide / task-wide rebuild is allowed.
  assert.doesNotMatch(sql, /rebuild_student_practice_item_state_full\(/);
});

test("BAS virtual sets are excluded and writing assignment attempts stay out of state", () => {
  assert.match(sql, /lower\(btrim\(source\.source_set_id\)\) !~ '\^\(grammar\|wrongbook\)-'/);
  assert.match(sql, /lower\(btrim\(source\.source_set_id\)\) !~ '\^\(grammar\|wrongbook\)-'/);
  const writingRebuild = sql.match(
    /create or replace function public\.rebuild_student_practice_item_state_writing[\s\S]*?\$\$;/
  )?.[0] ?? "";
  assert.ok(writingRebuild.length > 0);
  assert.match(writingRebuild, /attempt\.assignment_id is null/);
  const writingSync = sql.match(
    /create or replace function public\.sync_student_practice_item_state_writing[\s\S]*?\$\$;/
  )?.[0] ?? "";
  assert.ok(writingSync.length > 0);
  assert.match(writingSync, /old\.assignment_id is null/);
  assert.match(writingSync, /new\.assignment_id is null/);
});

test("BAS latest attempt follows submitted_at then created_at then attempt_id", () => {
  const rebuild = sql.match(
    /create or replace function public\.rebuild_student_practice_item_state_bas[\s\S]*?\$\$;/
  )?.[0] ?? "";
  assert.match(rebuild, /order by coalesce\(attempt\.submitted_at, attempt\.created_at\) desc nulls last,\s*attempt\.attempt_id desc/);
  assert.match(rebuild, /'build_sentence', p_item_id::text, 'completed'/);
});

test("public item predicate mirrors the directory rules for both task families", () => {
  const body = sql.match(
    /create or replace function public\.practice_item_is_public[\s\S]*?\$\$;/
  )?.[0] ?? "";
  assert.ok(body.length > 0);
  // BAS formal source: set id present, raw question empty.
  assert.match(body, /item\.task_type = 'build_sentence'\s*\n\s*and source\.source_set_id is not null\s*\n\s*and source\.source_set_id <> ''\s*\n\s*and source\.source_question_id is null/);
  // Writing formal source: raw question id only. Requiring source_set_id to be
  // null here silently excluded every writing item (importer stores both ids).
  assert.match(body, /item\.task_type <> 'build_sentence'\s*\n\s*and source\.source_question_id is not null\s*\n\s*and source\.source_question_id <> ''\)/);
  assert.doesNotMatch(body, /source\.source_question_id is not null\s*\n\s*and source\.source_set_id is null/);
  // Canonical count must only consider formal sources.
  assert.match(body, /and source\.is_canonical\s*\n\s*and \(/);
  // BAS canonical source must not be a virtual grammar / wrongbook set.
  assert.match(body, /lower\(btrim\(source\.source_set_id\)\) !~ '\^\(grammar\|wrongbook\)-'/);
});

test("catalog revisions are per task type and cache kind with a trigger-only bump", () => {
  assert.match(sql, /create table if not exists public\.catalog_revisions/);
  assert.match(sql, /primary key \(task_type, cache_kind\)/);
  assert.match(sql, /check \(cache_kind in \('lightweight_catalog', 'search_index'\)\)/);
  assert.match(sql, /create or replace function public\.bump_catalog_revision\(/);
  assert.match(sql, /set revision = revisions\.revision \+ 1/);
  for (const trigger of [
    "trg_practice_items_catalog_revision",
    "trg_practice_item_sources_catalog_revision",
    "trg_practice_item_occurrences_catalog_revision",
    "trg_questions_catalog_revision",
    "trg_practice_item_question_map_catalog_revision",
    "trg_email_questions_catalog_revision",
    "trg_academic_discussion_questions_catalog_revision",
    "trg_reading_logical_items_catalog_revision",
    "trg_reading_source_occurrences_catalog_revision"
  ]) {
    assert.match(sql, new RegExp(`create trigger ${trigger}`));
  }
});

test("occurrence writes bump only the lightweight catalog; content writes bump the search index", () => {
  const occurrence = sql.match(
    /create or replace function public\.sync_catalog_revision_practice_item_occurrences[\s\S]*?\$\$;/
  )?.[0] ?? "";
  assert.ok(occurrence.length > 0);
  assert.match(occurrence, /'lightweight_catalog'/);
  assert.doesNotMatch(occurrence, /'search_index'/);

  const readingOccurrence = sql.match(
    /create or replace function public\.sync_catalog_revision_reading_source_occurrences[\s\S]*?\$\$;/
  )?.[0] ?? "";
  assert.ok(readingOccurrence.length > 0);
  assert.match(readingOccurrence, /'full_set', 'lightweight_catalog'/);
  assert.doesNotMatch(readingOccurrence, /'search_index'/);

  const logicalItems = sql.match(
    /create or replace function public\.sync_catalog_revision_reading_logical_items[\s\S]*?\$\$;/
  )?.[0] ?? "";
  assert.ok(logicalItems.length > 0);
  assert.match(logicalItems, /old\.catalog_search_text is distinct from new\.catalog_search_text/);

  const questions = sql.match(
    /create or replace function public\.sync_catalog_revision_questions[\s\S]*?\$\$;/
  )?.[0] ?? "";
  assert.ok(questions.length > 0);
  assert.match(questions, /'search_index'/);

  // practice_items UPDATE only invalidates the search index when the
  // searchable set changes: task type, active flag, or the display number
  // becoming empty / non-empty. Pure directory fields (number value, title,
  // first_seen) never do; this database refreshes first_seen on every
  // occurrence write.
  const practiceItems = sql.match(
    /create or replace function public\.sync_catalog_revision_practice_items[\s\S]*?\$\$;/
  )?.[0] ?? "";
  assert.ok(practiceItems.length > 0);
  assert.match(practiceItems, /'lightweight_catalog'/);
  assert.match(practiceItems, /v_search_membership_changed/);
  assert.match(practiceItems, /old\.task_type is distinct from new\.task_type/);
  assert.match(practiceItems, /old\.is_active is distinct from new\.is_active/);
  assert.match(practiceItems, /nullif\(btrim\(coalesce\(old\.display_number, ''\)\), ''\)/);
  assert.match(practiceItems, /nullif\(btrim\(coalesce\(new\.display_number, ''\)\), ''\)/);
  // A task-type move must also leave the old task caches.
  assert.match(practiceItems, /bump_catalog_revision\(old\.task_type, 'lightweight_catalog'\)/);
  assert.match(practiceItems, /bump_catalog_revision\(old\.task_type, 'search_index'\)/);
});

test("backfill runs under a lock and covers all four attempt families", () => {
  const lockIndex = sql.indexOf("in share row exclusive mode");
  const backfillIndex = sql.indexOf("-- Backfill: BAS logical items");
  const triggerIndex = sql.indexOf("-- Enable incremental maintenance only after the snapshot is complete");
  assert.ok(lockIndex > 0, "lock statement must exist");
  assert.ok(backfillIndex > lockIndex, "backfill must run after the lock");
  assert.ok(triggerIndex > backfillIndex, "state triggers must be created after the backfill");

  const backfill = sql.slice(backfillIndex, triggerIndex);
  assert.equal(
    (backfill.match(/insert into public\.student_practice_item_state as state/g) ?? []).length,
    4
  );
  assert.equal(
    (backfill.match(/on conflict \(student_id, task_type, item_id\) do update/g) ?? []).length,
    4
  );
  assert.doesNotMatch(backfill, /attempt_count \+ 1/);
  assert.match(sql, /raise exception 'student_practice_item_state structural check failed/);
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;/m);
});

test("purposeful indexes cover the trigger and rebuild read paths", () => {
  assert.match(sql, /create index if not exists attempts_trimmed_set_identity_idx\s*\n\s*on public\.attempts \(btrim\(set_id\)\)/);
  assert.match(sql, /create index if not exists writing_attempts_question_identity_idx\s*\n\s*on public\.writing_attempts \(question_id, user_id\)/);
  // No duplicate indexes on the state table: the primary key is the read path.
  assert.doesNotMatch(sql, /student_practice_item_state_student_idx/);
});

test("parity verification file is read-only and ships one result set", () => {
  assert.doesNotMatch(verify, /insert into|update public|delete from|\.rpc\(/i);
  for (const marker of [
    "-- P1: Build a Sentence",
    "-- P2: Write an Email / Academic Discussion (free practice only)",
    "-- P3: Reading CTW / RDL / RAP",
    "-- P4: Reading Full Set"
  ]) {
    assert.match(verify, new RegExp(marker.replace(/[()]/g, "\\$&")));
  }
  assert.match(verify, /missing_state_rows/);
  assert.match(verify, /extra_state_rows/);
  assert.match(verify, /value_mismatches/);
  // Each task family must restrict the state side through its own CTE, not
  // through the FULL JOIN ON clause (that would report other task types as
  // extra_state_rows).
  assert.equal((verify.match(/full join target_/g) ?? []).length, 4);
  assert.equal((verify.match(/target_(bas|writing|reading|full_set) as \(/g) ?? []).length, 4);
  assert.doesNotMatch(verify, /full join public\.student_practice_item_state/);
  assert.match(verify, /where state\.task_type = 'build_sentence'/);
  assert.match(verify, /where state\.task_type in \('email', 'academic_discussion'\)/);
  assert.match(verify, /where state\.task_type in \('ctw', 'rdl', 'rap'\)/);
  assert.match(verify, /where state\.task_type = 'full_set'/);
  // V5 must qualify trigger_name; information_schema.triggers has one too.
  assert.doesNotMatch(verify, /^\s+trigger_name,\s*$/m);
  assert.match(verify, /required\.trigger_name/);
  assert.match(verify, /trigger\.trigger_schema = 'public'/);
  // information_schema lists one row per event; the query aggregates back to
  // exactly one row per trigger with an event_count.
  assert.match(verify, /'event_count', count\(trigger\.trigger_name\)/);
  assert.match(verify, /group by required\.trigger_name/);
  // The expected side must not share the migration predicate it verifies.
  const verifyCode = verify
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(verifyCode, /practice_item_is_public/);
  assert.match(verifyCode, /catalog_items as \(/);
  assert.equal((verifyCode.match(/join catalog_items catalog/g) ?? []).length, 2);
  assert.match(verify, /item\.task_type <> 'build_sentence'\s*\n\s*and source\.source_question_id is not null\s*\n\s*and source\.source_question_id <> ''\)/);
  assert.match(verify, /assignment_id is null/);
  // The whole file is one SELECT so the SQL editor shows every check at once.
  assert.equal((verify.match(/^with$/gm) ?? []).length, 1);
  for (const block of ["parity_rows", "trigger_rows", "state_rows", "revision_rows"]) {
    assert.match(verify, new RegExp(`${block} as \\(`));
  }
  assert.match(verify, /order by checks\.section, checks\.check_name;\s*$/);
});

test("trigger verification file is rollback-only and proves direct SQL visibility", () => {
  assert.equal((triggerVerify.match(/^begin;/gm) ?? []).length, 1);
  assert.equal((triggerVerify.match(/^rollback;/gm) ?? []).length, 1);
  assert.doesNotMatch(triggerVerify, /^commit;/m);
  const successIndex = triggerVerify.indexOf("select 'ALL_CHECKS_PASSED' as result;");
  const rollbackIndex = triggerVerify.indexOf("\nrollback;");
  assert.ok(successIndex > 0 && rollbackIndex > successIndex, "result row must precede rollback");
  for (const marker of [
    "T1 failed",
    "T3 failed",
    "T4 failed",
    "T5 failed",
    "T6 failed",
    "T7 failed",
    "T8 failed",
    "T9 failed",
    "T11 failed",
    "T12 failed",
    "T13 failed",
    "T16 failed",
    "T17 failed",
    "T18 failed",
    "T19a failed",
    "T19b failed",
    "T20a failed",
    "T20b failed"
  ]) {
    assert.match(triggerVerify, new RegExp(marker));
  }
  // Direct SQL occurrence writes bump the revision used by the app caches.
  assert.match(triggerVerify, /insert into public\.practice_item_occurrences/);
  assert.match(triggerVerify, /insert into public\.reading_source_occurrences/);
  assert.match(triggerVerify, /did not bump/);
  // The revision delta must be deterministic on a live database: serialize
  // against concurrent imports and reject duplicate revision triggers.
  assert.match(triggerVerify, /lock table public\.catalog_revisions in exclusive mode/);
  assert.match(triggerVerify, /T19 precondition failed: expected exactly 9 catalog revision triggers/);
  assert.match(triggerVerify, /pg_trigger/);
  // T19a/T20a verify the full production chain (occurrence -> first-seen ->
  // practice_items UPDATE) without invalidating the search index; T19b/T20b
  // disable other user triggers inside the rolled-back transaction and require
  // an exact +1 from our trigger only.
  assert.match(triggerVerify, /disable trigger %I/);
  assert.match(triggerVerify, /trigger\.tgname <> 'trg_practice_item_occurrences_catalog_revision'/);
  assert.match(triggerVerify, /trigger\.tgname <> 'trg_reading_source_occurrences_catalog_revision'/);
  assert.doesNotMatch(triggerVerify, /jsonb_populate_record/);
});
