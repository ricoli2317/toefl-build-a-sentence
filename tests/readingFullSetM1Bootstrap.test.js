const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  clearReadingFullSetBootstrapHandoffs,
  consumeReadingFullSetBootstrapHandoff,
  readingFullSetBootstrapHandoffKey,
  storeReadingFullSetBootstrapHandoff
} = require("../lib/reading/fullSetBootstrapHandoff.client.ts");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const startRoute = read("app/api/reading/full-set-attempts/route.ts");
const fallbackRoute = read("app/api/reading/full-set-attempts/[attemptId]/route.ts");
const detail = read("components/reading/ReadingFullSetDetail.tsx");
const runner = read("components/reading/ReadingFullSetRunner.tsx");
const performanceClient = read("lib/reading/fullSetPerformance.client.ts");
const serverHelper = read("lib/reading/fullSetAttemptServer.ts");
const performanceServer = read("lib/studentPerformance.server.ts");
const lifecycle = read("supabase/reading_full_set_preparing_load_lease_20260914.sql");

function moduleAttempt(overrides = {}) {
  return {
    answerRevision: 0,
    currentOccurrenceId: null,
    currentQuestionIndex: null,
    cursorRevision: 0,
    deadlineAt: null,
    remainingSeconds: 1230,
    timerRevision: 0,
    moduleAttemptId: "module-attempt-1",
    moduleNumber: 1,
    startedAt: null,
    status: "preparing",
    submissionReason: null,
    submittedAt: null,
    timeLimitSeconds: 1230,
    ...overrides
  };
}

function bootstrap(overrides = {}) {
  const module1 = moduleAttempt(overrides.module1);
  return {
    firstOccurrence: {
      answerRevision: module1.answerRevision,
      answers: {},
      occurrence: {
        logicalItemId: "reading-ctw-aaaaaaaaaaaaaaaaaaaaaaaa",
        occurrenceId: "occurrence-1",
        sourceQuestionEnd: 10,
        sourceQuestionStart: 1,
        taskType: "ctw"
      },
      practice: { item: { module: "ctw" }, questions: [{}] },
      questionTimes: {}
    },
    runner: {
      attempt: {
        attemptId: overrides.attemptId ?? "attempt-1",
        completedAt: null,
        currentModule: 1,
        fullSetId: overrides.fullSetId ?? "20260601A",
        module1,
        module2: null,
        serverNow: "2026-09-15T00:00:00.000Z",
        startedAt: "2026-09-15T00:00:00.000Z",
        status: "in_progress"
      },
      occurrences: [{
        logicalItemId: "reading-ctw-aaaaaaaaaaaaaaaaaaaaaaaa",
        occurrenceId: "occurrence-1",
        sourceQuestionEnd: 10,
        sourceQuestionStart: 1,
        taskType: "ctw"
      }],
      title: "20260601A"
    },
    traceId: "trace-1"
  };
}

test("M1 Start is one idempotent bootstrap returning preparing attempt and first CTW", () => {
  assert.match(startRoute, /get_or_create_reading_full_set_attempt/);
  assert.match(startRoute, /phase !== "module_1_preparing" && phase !== "module_1_active"/);
  assert.match(startRoute, /attempt\.module1\.status === "preparing" && initialOccurrence\.taskType !== "ctw"/);
  assert.match(startRoute, /loadReadingFullSetOccurrencePracticePayload/);
  assert.match(startRoute, /const runner = buildReadingFullSetRunnerPayload[\s\S]*firstOccurrence[\s\S]*runner,[\s\S]*traceId/);
  assert.doesNotMatch(startRoute, /activate_reading_full_set_module/);
  assert.match(lifecycle, /status, time_limit_seconds, started_at, deadline_at[\s\S]*'preparing',[\s\S]*null, null/);
  assert.match(lifecycle, /where student_id = v_user_id and full_set_id = p_full_set_id and status = 'in_progress'/);
});

test("M1 bootstrap resolves one directed definition and classifies server phases", () => {
  assert.equal((startRoute.match(/loadReadingFullSet\(db, fullSetId\)/g) ?? []).length, 1);
  assert.doesNotMatch(startRoute, /loadReadingFullSets|findValidReadingFullSet/);
  for (const phase of [
    "auth",
    "profile_validation",
    "attempt_create_or_reuse",
    "definition_resolution",
    "ownership",
    "m1_prepare",
    "first_occurrence_content",
    "answers",
    "serialization",
    "api_total"
  ]) assert.match(`${startRoute}\n${serverHelper}\n${performanceServer}`, new RegExp(`"${phase}"`));
  assert.match(startRoute, /BOOTSTRAP_TIMEOUT_MS = 15_000/);
  assert.match(startRoute, /BOOTSTRAP_TIMEOUT/);
});

test("Detail hands M1 bootstrap to Runner, which skips runner and occurrence GETs", () => {
  assert.match(detail, /storeReadingFullSetBootstrapHandoff\(bootstrap, trace\)/);
  assert.match(runner, /consumeReadingFullSetBootstrapHandoff/);
  const handoffBranch = runner.slice(
    runner.indexOf("const handoff = consumeReadingFullSetBootstrapHandoff"),
    runner.indexOf("initialPause = await beginLoadPause")
  );
  assert.match(handoffBranch, /applyBootstrap\(handoff, 1\)/);
  assert.doesNotMatch(handoffBranch, /loadRunner|occurrences\/|beginLoadPause/);
});

test("handoff is keyed by attempt and module attempt, consumed once, and expires", () => {
  clearReadingFullSetBootstrapHandoffs();
  const payload = bootstrap();
  const trace = { attemptId: "attempt-1", startedAt: 10, traceId: "trace-1" };
  assert.equal(
    readingFullSetBootstrapHandoffKey("attempt-1", payload.runner.attempt.module1),
    "attempt-1:1:module-attempt-1"
  );
  storeReadingFullSetBootstrapHandoff(payload, trace, 1000);
  assert.ok(consumeReadingFullSetBootstrapHandoff({
    attemptId: "attempt-1",
    expectedFullSetId: "20260601A",
    now: 1001
  }));
  assert.equal(consumeReadingFullSetBootstrapHandoff({
    attemptId: "attempt-1",
    expectedFullSetId: "20260601A",
    now: 1002
  }), null);

  storeReadingFullSetBootstrapHandoff(payload, trace, 1000);
  assert.equal(consumeReadingFullSetBootstrapHandoff({
    attemptId: "attempt-1",
    expectedFullSetId: "20260601A",
    now: 62_000
  }), null);
});

test("refresh fallback is one directed runner/content bootstrap and preserves active deadline", () => {
  assert.match(fallbackRoute, /loadReadingFullSet\(db, owned\.attempt!\.fullSetId\)/);
  assert.doesNotMatch(fallbackRoute, /loadReadingFullSets|findValidReadingFullSet/);
  assert.match(fallbackRoute, /loadReadingFullSetOccurrencePracticePayload/);
  assert.match(runner, /if \(moduleAttempt && payload\.firstOccurrence\)[\s\S]*applyBootstrap\(payload, moduleAttempt\.moduleNumber\)/);
  assert.match(runner, /if \(!activeLoadPauseRef\.current\) setTimerPausedForLoad\(false\)/);
  assert.match(runner, /moduleAttempt\.status === "active"[\s\S]*finishLoadPause\(accessToken, pause\.loadId\)/);
  assert.doesNotMatch(fallbackRoute, /activate_reading_full_set_module|deadlineAt\s*=/);
});

test("M1 first-interactive activates before countdown and still enables rolling one-ahead prefetch", () => {
  const ready = runner.slice(runner.indexOf("const handleWorkspaceReady"), runner.indexOf("const commitActiveQuestionTime"));
  assert.match(ready, /`\$\{prefix\}_first_interactive`/);
  assert.match(ready, /`\$\{prefix\}_activation_start`/);
  assert.match(ready, /modules\/\$\{moduleAttempt\.moduleNumber\}\/activate/);
  assert.match(ready, /`\$\{prefix\}_activation_end`/);
  assert.match(ready, /`\$\{prefix\}_countdown_active`/);
  assert.ok(ready.indexOf("`${prefix}_first_interactive`") < ready.indexOf("fetchReadingFullSetWithTimeout"));

  const prefetch = runner.slice(
    runner.indexOf("interactiveOccurrenceId !== currentOccurrence.occurrenceId"),
    runner.indexOf("const commitActiveQuestionTime")
  );
  assert.match(prefetch, /position\.occurrenceIndex \+ 1/);
  assert.match(prefetch, /next_prefetch_start/);
  assert.match(prefetch, /acquireOccurrence\([\s\S]*prefetch: true/);
  assert.match(runner, /setInteractiveOccurrenceId\(occurrence\.occurrenceId\)/);
});

test("M1 bootstrap does not load future RDL resources; existing background preload remains", () => {
  assert.doesNotMatch(startRoute, /nextOccurrence|imageUrl|Image\(|decode\(|rdl_image/);
  assert.match(runner, /input\.occurrence\.taskType === "rdl"[\s\S]*imagePreloadCacheRef\.current\.acquire/);
  assert.match(runner, /rdl_image_preload_start/);
  assert.match(runner, /rdl_image_preload_end/);
  assert.match(runner, /if \(input\.prefetch\)[\s\S]*next_prefetch_ready/);
});

test("M1 trace reuses the correlation id without answer or content fields", () => {
  for (const phase of [
    "m1_start_click",
    "m1_start_request_start",
    "m1_attempt_prepare",
    "m1_definition_resolution",
    "m1_first_occurrence_content",
    "m1_bootstrap_response",
    "m1_route_navigation",
    "m1_state_applied",
    "m1_first_ctw_mounted",
    "m1_first_interactive",
    "m1_activation_start",
    "m1_activation_end",
    "m1_countdown_active"
  ]) assert.match(performanceClient, new RegExp(`"${phase}"`));
  assert.match(detail, /readingFullSetTraceHeaders\(accessToken, trace\)/);
  assert.match(runner, /transitionTraceRef\.current = handoff\.trace/);
  assert.doesNotMatch(performanceClient, /studentAnswer|student_answer|question.*text|selectionMap/);
});
