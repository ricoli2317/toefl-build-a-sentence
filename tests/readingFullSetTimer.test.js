const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createReadingFullSetTimerState,
  isReadingFullSetAttemptTimerStale,
  mergeReadingFullSetTimerState,
  readReadingFullSetTimer
} = require("../lib/reading/fullSetTimer.ts");
const {
  moveReadingFullSetPosition,
  readingFullSetActiveModuleAttempt,
  readingFullSetAttemptPhase
} = require("../lib/reading/fullSetAttempts.ts");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const runner = read("components/reading/ReadingFullSetRunner.tsx");
const timerMigration = read("supabase/reading_full_set_module_timer_pause_20260915.sql");
const pauseRoute = read("app/api/reading/full-set-attempts/[attemptId]/modules/[moduleNumber]/pause/route.ts");

function moduleAttempt(moduleNumber, overrides = {}) {
  const timeLimitSeconds = moduleNumber === 1 ? 1230 : 540;
  return {
    answerRevision: 0,
    currentOccurrenceId: null,
    currentQuestionIndex: null,
    cursorRevision: 0,
    deadlineAt: "2026-09-15T00:20:30.000Z",
    moduleAttemptId: `00000000-0000-4000-8000-00000000000${moduleNumber}`,
    moduleNumber,
    remainingSeconds: timeLimitSeconds,
    startedAt: "2026-09-15T00:00:00.000Z",
    status: "active",
    submissionReason: null,
    submittedAt: null,
    timeLimitSeconds,
    timerRevision: 1,
    ...overrides
  };
}

function attempt(moduleNumber = 1, moduleOverrides = {}) {
  const module = moduleAttempt(moduleNumber, moduleOverrides);
  return {
    attemptId: "00000000-0000-4000-8000-000000000010",
    completedAt: null,
    currentModule: moduleNumber,
    fullSetId: "20260601A",
    module1: moduleNumber === 1 ? module : moduleAttempt(1, {
      deadlineAt: "2026-09-15T00:10:00.000Z",
      remainingSeconds: 0,
      status: "submitted",
      submissionReason: "manual",
      submittedAt: "2026-09-15T00:10:00.000Z"
    }),
    module2: moduleNumber === 2 ? module : null,
    serverNow: "2026-09-15T00:00:00.000Z",
    startedAt: "2026-09-15T00:00:00.000Z",
    status: "in_progress"
  };
}

test("M1 Module clock counts down smoothly from one Module-level owner", () => {
  const timer = createReadingFullSetTimerState(attempt(), 10_000);
  assert.equal(readReadingFullSetTimer(timer, 10_000), 1230);
  assert.equal(readReadingFullSetTimer(timer, 25_000), 1215);
  assert.equal(readReadingFullSetTimer(timer, 25_900), 1215);
});

test("CTW → RDL, RDL → RAP, RAP → RDL, Previous/Next, and Review preserve the active timer", () => {
  const initial = createReadingFullSetTimerState(attempt(), 0);
  const navigationResponse = attempt(1, {
    deadlineAt: "2026-09-15T00:21:15.000Z",
    remainingSeconds: 1230
  });
  for (const transition of ["CTW → RDL", "RDL → RAP", "RAP → RDL", "Previous/Next", "Review jump"]) {
    const before = readReadingFullSetTimer(initial, 60_000);
    const merged = mergeReadingFullSetTimerState({
      clientNowMs: 60_000,
      current: initial,
      incomingAttempt: navigationResponse,
      mode: "preserve_active"
    });
    assert.equal(readReadingFullSetTimer(merged, 60_000), before, transition);
    assert.ok(readReadingFullSetTimer(merged, 61_000) <= before, transition);
  }
  const occurrences = [
    { taskType: "ctw", sourceQuestionStart: 1, sourceQuestionEnd: 10 },
    { taskType: "rdl", sourceQuestionStart: 11, sourceQuestionEnd: 12 },
    { taskType: "rap", sourceQuestionStart: 13, sourceQuestionEnd: 17 }
  ];
  assert.deepEqual(moveReadingFullSetPosition(occurrences, { occurrenceIndex: 0, questionIndex: 0 }, 1), { occurrenceIndex: 1, questionIndex: 0 });
});

test("occurrence completion cannot overwrite the timer and a stale timer revision is rejected", () => {
  const currentAttempt = attempt(1, { timerRevision: 4 });
  const current = createReadingFullSetTimerState(currentAttempt, 0);
  const stale = attempt(1, {
    deadlineAt: "2026-09-15T00:30:00.000Z",
    remainingSeconds: 1230,
    timerRevision: 3
  });
  assert.equal(isReadingFullSetAttemptTimerStale(currentAttempt, stale), true);
  assert.strictEqual(mergeReadingFullSetTimerState({ current, incomingAttempt: stale, clientNowMs: 90_000 }), current);
  assert.match(runner, /requestId !== occurrenceRequestRef\.current \|\| generation !== runnerGenerationRef\.current/);
  assert.match(runner, /isReadingFullSetAttemptTimerStale\(current\.attempt, attempt\)/);

  const m1Submitted = attempt(1, {
    remainingSeconds: 0,
    status: "submitted",
    submissionReason: "manual",
    submittedAt: "2026-09-15T00:10:00.000Z"
  });
  assert.equal(isReadingFullSetAttemptTimerStale(m1Submitted, currentAttempt), true);
});

test("Exit persists current remaining seconds with module-attempt and timer-revision CAS", () => {
  assert.match(runner, /pauseActiveModule[\s\S]*expectedTimerRevision: timer\.timerRevision[\s\S]*moduleAttemptId: moduleAttempt\.moduleAttemptId[\s\S]*remainingSeconds:/);
  assert.match(runner, /pagehide[\s\S]*popstate/);
  assert.match(pauseRoute, /pause_reading_full_set_module/);
  assert.match(timerMigration, /v_remaining := least\(v_server_remaining, p_remaining_seconds, v_module\.time_limit_seconds\)/);
  assert.match(timerMigration, /set status = 'paused',[\s\S]*remaining_seconds = v_remaining[\s\S]*deadline_at = null/);
});

test("30 minutes outside the runner and a refresh do not consume a paused Module", () => {
  const pausedAttempt = attempt(1, {
    deadlineAt: null,
    remainingSeconds: 452,
    status: "paused",
    timerRevision: 2
  });
  const exited = createReadingFullSetTimerState(pausedAttempt, 0);
  assert.equal(readReadingFullSetTimer(exited, 30 * 60 * 1000), 452);
  const refreshed = createReadingFullSetTimerState({
    ...pausedAttempt,
    serverNow: "2026-09-15T00:30:00.000Z"
  }, 30 * 60 * 1000);
  assert.equal(readReadingFullSetTimer(refreshed, 30 * 60 * 1000), 452);

  const resumedAttempt = attempt(1, {
    deadlineAt: "2026-09-15T00:37:32.000Z",
    remainingSeconds: 452,
    timerRevision: 3
  });
  const resumed = mergeReadingFullSetTimerState({
    clientNowMs: 30 * 60 * 1000,
    current: refreshed,
    incomingAttempt: { ...resumedAttempt, serverNow: "2026-09-15T00:30:00.000Z" },
    mode: "authoritative"
  });
  assert.equal(readReadingFullSetTimer(resumed, 30 * 60 * 1000), 452);
  assert.equal(readReadingFullSetTimer(resumed, 30 * 60 * 1000 + 10_000), 442);
});

test("M1 and M2 own independent clocks and M2 begins with its full initial limit", () => {
  const m1 = createReadingFullSetTimerState(attempt(1), 0);
  assert.equal(readReadingFullSetTimer(m1, 300_000), 930);
  const m2Attempt = attempt(2, {
    deadlineAt: null,
    remainingSeconds: 540,
    startedAt: null,
    status: "preparing",
    timerRevision: 0
  });
  const m2 = mergeReadingFullSetTimerState({ current: m1, incomingAttempt: m2Attempt, clientNowMs: 300_000 });
  assert.equal(m2.moduleAttemptId, m2Attempt.module2.moduleAttemptId);
  assert.equal(readReadingFullSetTimer(m2, 2_100_000), 540);
  assert.notEqual(m2.moduleAttemptId, m1.moduleAttemptId);
});

test("M2 Exit/Resume never restores M1 and submitted Modules never reopen", () => {
  const pausedM2 = attempt(2, {
    deadlineAt: null,
    remainingSeconds: 211,
    status: "paused",
    timerRevision: 5
  });
  assert.equal(readingFullSetAttemptPhase(pausedM2), "module_2_active");
  assert.equal(createReadingFullSetTimerState(pausedM2, 0).moduleAttemptId, pausedM2.module2.moduleAttemptId);
  const completed = {
    ...pausedM2,
    completedAt: "2026-09-15T01:00:00.000Z",
    module2: moduleAttempt(2, {
      remainingSeconds: 0,
      status: "submitted",
      submissionReason: "manual",
      submittedAt: "2026-09-15T01:00:00.000Z"
    }),
    status: "completed"
  };
  assert.equal(readingFullSetAttemptPhase(completed), "completed");
  assert.equal(readingFullSetActiveModuleAttempt(completed), null);
  assert.equal(createReadingFullSetTimerState(completed, 0), null);
  assert.match(timerMigration, /if v_module\.status = 'submitted' then[\s\S]*FULL_SET_MODULE_NOT_PREPARING/);
});

test("zero triggers the existing timeout submit guard once", () => {
  const timer = createReadingFullSetTimerState(attempt(2, {
    deadlineAt: "2026-09-15T00:00:01.000Z",
    remainingSeconds: 1
  }), 0);
  assert.equal(readReadingFullSetTimer(timer, 1_000), 0);
  assert.match(runner, /remaining === 0[\s\S]*!timeoutSubmitStartedRef\.current[\s\S]*timeoutSubmitStartedRef\.current = true[\s\S]*submitModule\(true\)/);
});

test("timer persistence adds no per-second API writes and remains Reading Full Set scoped", () => {
  const countdownEffect = runner.slice(runner.indexOf("const update = () =>"), runner.indexOf("const retryOccurrence"));
  assert.doesNotMatch(countdownEffect, /fetch\(/);
  assert.match(countdownEffect, /window\.setInterval\(update, 250\)/);
  assert.doesNotMatch(timerMigration, /writing|build.a.sentence|bas_/i);
  assert.match(timerMigration, /reading_full_set_module_attempts/);
});
