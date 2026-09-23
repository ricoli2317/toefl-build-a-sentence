import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canUseStudentExperience } from "../lib/accountPermissions.ts";

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");

test("Student, Teacher, and Admin all have Student Experience capability", () => {
  assert.equal(canUseStudentExperience("student"), true);
  assert.equal(canUseStudentExperience("teacher"), true);
  assert.equal(canUseStudentExperience("admin"), true);
});

test("CTW, RDL, and RAP start through one owned Reading attempt RPC", async () => {
  const route = await read("../app/api/reading/attempts/route.ts");
  assert.match(route, /requireReadingAttemptStudent\(request\)/);
  assert.match(route, /reading-\(ctw\|rdl\|rap\)-/);
  assert.match(route, /rpc\("get_or_create_reading_attempt"/);

  const migration = await read("../supabase/reading_student_experience_access_20260923.sql");
  assert.match(migration, /can_use_student_experience\(\)/);
  assert.match(migration, /get_or_create_reading_attempt\(text\)/);
});

test("ordinary Reading submit, result, review, retake, and history reuse the same auth gate", async () => {
  for (const file of [
    "../app/api/reading/attempts/[attemptId]/submit/route.ts",
    "../app/api/reading/results/[attemptId]/route.ts",
    "../app/api/reading/attempts/[attemptId]/review/route.ts",
    "../app/api/reading/attempts/[attemptId]/retake/route.ts",
    "../app/api/reading/history/route.ts"
  ]) {
    assert.match(await read(file), /requireReadingAttemptStudent\(request\)/, file);
  }

  const result = await read("../app/api/reading/results/[attemptId]/route.ts");
  assert.match(result, /Verify ownership and submission before the service-role detail query/);
  assert.match(result, /auth\.client[\s\S]*\.eq\("attempt_id", params\.attemptId\)/);
});

test("Full Set start, save, submit, result, review, and resume share the Full Set auth gate", async () => {
  for (const file of [
    "../app/api/reading/full-set-attempts/route.ts",
    "../app/api/reading/full-set-attempts/[attemptId]/route.ts",
    "../app/api/reading/full-set-attempts/[attemptId]/occurrences/[occurrenceId]/route.ts",
    "../app/api/reading/full-set-attempts/[attemptId]/modules/[moduleNumber]/submit/route.ts",
    "../app/api/reading/full-sets/[fullSetId]/results/[attemptId]/route.ts",
    "../app/api/reading/full-sets/[fullSetId]/results/[attemptId]/review/route.ts"
  ]) {
    assert.match(await read(file), /requireReadingFullSetStudent\(request/, file);
  }

  const start = await read("../app/api/reading/full-set-attempts/route.ts");
  assert.match(start, /rpc\("get_or_create_reading_full_set_attempt"/);
  assert.match(start, /\.eq\("student_id", auth\.userId\)/);
});

test("Reading wrongbook creation follows the same Student Experience migration", async () => {
  const route = await read("../app/api/reading/wrongbook-attempts/route.ts");
  assert.match(route, /requireReadingAttemptStudent\(request\)/);
  assert.match(route, /get_or_create_reading_wrongbook_attempt/);
  assert.match(route, /get_or_create_reading_full_set_wrongbook_attempt/);

  const migration = await read("../supabase/reading_student_experience_access_20260923.sql");
  assert.match(migration, /get_or_create_reading_wrongbook_attempt\(text,text,jsonb\)/);
  assert.match(migration, /get_or_create_reading_full_set_wrongbook_attempt\(uuid,text,text,jsonb\)/);
});

test("the SQL hotfix changes only role capability and preserves self ownership", async () => {
  const migration = await read("../supabase/reading_student_experience_access_20260923.sql");
  assert.match(migration, /profile\.id = auth\.uid\(\)/);
  assert.match(migration, /profile\.role::text in \('student', 'teacher', 'admin'\)/);
  assert.match(migration, /position\('public\.can_use_student_experience\(\)' in v_definition\) > 0/);
  assert.doesNotMatch(migration, /update\s+public\.profiles|insert\s+into\s+public\.profiles/i);

  for (const file of [
    "../supabase/reading_attempts.sql",
    "../supabase/reading_full_set_preparing_load_lease_20260914.sql",
    "../supabase/reading_wrongbook_corrections.sql",
    "../supabase/reading_full_set_wrongbook_corrections.sql"
  ]) {
    assert.match(await read(file), /student_id = v_user_id/, file);
  }
});
