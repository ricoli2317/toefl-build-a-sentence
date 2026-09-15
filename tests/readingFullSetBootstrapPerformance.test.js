const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  ReadingFullSetTimeoutError,
  withReadingFullSetTimeout
} = require("../lib/reading/fullSetTimeout.ts");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const bootstrap = read("app/api/reading/full-set-attempts/[attemptId]/modules/2/start/route.ts");
const activation = read("app/api/reading/full-set-attempts/[attemptId]/modules/[moduleNumber]/activate/route.ts");
const submission = read("app/api/reading/full-set-attempts/[attemptId]/modules/[moduleNumber]/submit/route.ts");
const runner = read("components/reading/ReadingFullSetRunner.tsx");
const serverHelper = read("lib/reading/fullSetAttemptServer.ts");
const definition = read("lib/reading/fullSets.server.ts");
const performanceClient = read("lib/reading/fullSetPerformance.client.ts");
const performanceServer = read("lib/studentPerformance.server.ts");
const lifecycle = read("supabase/reading_full_set_preparing_load_lease_20260914.sql");

test("M2 bootstrap validates ownership, prepares idempotently, and returns its initial state", () => {
  assert.match(bootstrap, /requireReadingFullSetStudent\(request, timing\)/);
  assert.match(bootstrap, /loadOwnedReadingFullSetAttempt/);
  assert.match(bootstrap, /ownedAttempt\.module1\.status !== "submitted"/);
  assert.match(bootstrap, /prepare_reading_full_set_module_2/);
  assert.match(bootstrap, /moduleAttempt\.status === "preparing" && initialOccurrence\.taskType !== "ctw"/);
  assert.match(bootstrap, /loadReadingFullSetOccurrencePracticePayload/);
  assert.match(bootstrap, /const runner = buildReadingFullSetRunnerPayload[\s\S]*firstOccurrence[\s\S]*runner,[\s\S]*traceId/);
  assert.match(
    serverHelper,
    /Promise\.all\(\[[\s\S]*practicePromise,[\s\S]*answerPromise,[\s\S]*occurrenceRevisionPromise[\s\S]*\]\)/
  );
});

test("bootstrap never activates and retry reuses the database's one M2 module attempt", () => {
  assert.doesNotMatch(bootstrap, /activate_reading_full_set_module/);
  assert.match(lifecycle, /insert into public\.reading_full_set_module_attempts[\s\S]*2, 'preparing'/);
  assert.match(lifecycle, /on conflict \(attempt_id, module_number\) do nothing/);
  assert.match(lifecycle, /started_at, deadline_at[\s\S]*null, null/);
  assert.match(activation, /activate_reading_full_set_module/);
  assert.match(lifecycle, /deadline_at = v_activated_at \+ make_interval\(secs => time_limit_seconds\)/);
});

test("normal M2 start is one bootstrap request plus one ready activation request", () => {
  const start = runner.slice(runner.indexOf("const startModule2"), runner.indexOf("if (loading)"));
  const ready = runner.slice(runner.indexOf("const handleWorkspaceReady"), runner.indexOf("const commitActiveQuestionTime"));
  assert.equal((start.match(/fetchReadingFullSetWithTimeout\(/g) ?? []).length, 1);
  assert.doesNotMatch(start, /loadRunner\(|occurrences\/\$\{/);
  assert.match(start, /result\.firstOccurrence/);
  assert.equal((ready.match(/fetchReadingFullSetWithTimeout\(/g) ?? []).length, 1);
  assert.match(ready, /\/activate/);
});

test("bootstrap resolves one date-scoped definition and avoids full catalog rebuild", () => {
  assert.equal((bootstrap.match(/loadReadingFullSet\(/g) ?? []).length, 1);
  assert.doesNotMatch(bootstrap, /loadReadingFullSets/);
  assert.match(definition, /query = query\.eq\("occurrence_date", occurrenceDate\)/);
  assert.match(definition, /loadReadingFullSet\([\s\S]*findValidReadingFullSet/);
});

test("bootstrap and activation have explicit timeouts without activation fallback", async () => {
  await assert.rejects(
    withReadingFullSetTimeout(new Promise(() => {}), 1, "BOOTSTRAP_TIMEOUT"),
    (error) => error instanceof ReadingFullSetTimeoutError && error.code === "BOOTSTRAP_TIMEOUT"
  );
  assert.match(bootstrap, /BOOTSTRAP_TIMEOUT_MS = 15_000/);
  assert.match(bootstrap, /BOOTSTRAP_TIMEOUT/);
  assert.match(activation, /10_000[\s\S]*"ACTIVATION_FAILED"/);
  assert.doesNotMatch(bootstrap, /status:\s*["']active/);
});

test("one correlation id covers required client and server phases without answer content", () => {
  for (const phase of [
    "m1_submit_click",
    "m1_final_flush_start",
    "m1_final_flush_end",
    "m1_submit_request_start",
    "m1_submit_request_end",
    "m2_start_click",
    "m2_bootstrap_request_start",
    "m2_bootstrap_response",
    "m2_state_applied",
    "m2_first_ctw_mounted",
    "m2_first_interactive",
    "m2_activation_start",
    "m2_activation_end",
    "m2_countdown_active"
  ]) assert.match(performanceClient, new RegExp(`"${phase}"`));
  for (const phase of [
    "auth",
    "profile_validation",
    "ownership",
    "m1_submit_rpc",
    "m2_prepare_rpc",
    "definition_resolution",
    "first_occurrence_content",
    "answers",
    "serialization",
    "api_total"
  ]) assert.match(`${bootstrap}\n${activation}\n${submission}\n${serverHelper}\n${performanceServer}`, new RegExp(`"${phase}"`));
  assert.match(performanceServer, /attemptId[\s\S]*moduleNumber[\s\S]*serverTimestamp[\s\S]*success[\s\S]*traceId/);
  assert.doesNotMatch(performanceClient, /studentAnswer|student_answer|question.*text|selectionMap/);
});
