const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  readingFullSetBootstrapOccurrence,
  readingFullSetRestoredPosition
} = require("../lib/reading/fullSetAttempts.ts");
const { ReadingFullSetCursorQueue } = require("../lib/reading/fullSetCursorQueue.client.ts");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const runner = read("components/reading/ReadingFullSetRunner.tsx");
const resumeRoute = read("app/api/reading/full-set-attempts/[attemptId]/route.ts");
const m1Route = read("app/api/reading/full-set-attempts/route.ts");
const m2Route = read("app/api/reading/full-set-attempts/[attemptId]/modules/2/start/route.ts");
const cursorRoute = read("app/api/reading/full-set-attempts/[attemptId]/modules/[moduleNumber]/cursor/route.ts");
const migration = read("supabase/reading_full_set_navigation_cursor_20260915.sql");

const occurrences = [
  { occurrenceId: "m1-ctw", logicalItemId: "ctw", taskType: "ctw", sourceQuestionStart: 1, sourceQuestionEnd: 10 },
  { occurrenceId: "m1-rdl", logicalItemId: "rdl", taskType: "rdl", sourceQuestionStart: 11, sourceQuestionEnd: 12 },
  { occurrenceId: "m1-rap", logicalItemId: "rap", taskType: "rap", sourceQuestionStart: 13, sourceQuestionEnd: 17 }
];

function moduleAttempt(overrides = {}) {
  return {
    answerRevision: 4,
    currentOccurrenceId: null,
    currentQuestionIndex: null,
    cursorRevision: 0,
    deadlineAt: "2026-09-15T12:30:00Z",
    moduleAttemptId: "module-1",
    moduleNumber: 1,
    startedAt: "2026-09-15T12:00:00Z",
    status: "active",
    submissionReason: null,
    submittedAt: null,
    timeLimitSeconds: 1230,
    ...overrides
  };
}

test("active CTW, RDL, and RAP cursors restore the persisted occurrence and workspace question", () => {
  for (const [occurrenceId, questionIndex, questionCount] of [
    ["m1-ctw", 0, 1],
    ["m1-rdl", 1, 2],
    ["m1-rap", 3, 5]
  ]) {
    const active = moduleAttempt({ currentOccurrenceId: occurrenceId, currentQuestionIndex: questionIndex });
    const occurrence = readingFullSetBootstrapOccurrence(occurrences, active);
    assert.equal(occurrence.occurrenceId, occurrenceId);
    assert.deepEqual(readingFullSetRestoredPosition({
      moduleAttempt: active,
      occurrences,
      questionCount,
      restoredOccurrenceId: occurrenceId
    }), {
      occurrenceIndex: occurrences.findIndex((candidate) => candidate.occurrenceId === occurrenceId),
      questionIndex
    });
  }
});

test("null or invalid occurrence falls back to the Module first occurrence", () => {
  assert.equal(readingFullSetBootstrapOccurrence(occurrences, moduleAttempt()).occurrenceId, "m1-ctw");
  const invalid = moduleAttempt({ currentOccurrenceId: "removed", currentQuestionIndex: 2 });
  const occurrence = readingFullSetBootstrapOccurrence(occurrences, invalid);
  assert.equal(occurrence.occurrenceId, "m1-ctw");
  assert.deepEqual(readingFullSetRestoredPosition({
    moduleAttempt: invalid,
    occurrences,
    questionCount: 1,
    restoredOccurrenceId: occurrence.occurrenceId
  }), { occurrenceIndex: 0, questionIndex: 0 });
});

test("valid occurrence with an invalid question index falls back within that occurrence", () => {
  const active = moduleAttempt({ currentOccurrenceId: "m1-rap", currentQuestionIndex: 99 });
  assert.deepEqual(readingFullSetRestoredPosition({
    moduleAttempt: active,
    occurrences,
    questionCount: 5,
    restoredOccurrenceId: "m1-rap"
  }), { occurrenceIndex: 2, questionIndex: 0 });
  const invalidCtwFocus = moduleAttempt({ currentOccurrenceId: "m1-ctw", currentQuestionIndex: 1 });
  assert.deepEqual(readingFullSetRestoredPosition({
    moduleAttempt: invalidCtwFocus,
    occurrences,
    questionCount: 10,
    restoredOccurrenceId: "m1-ctw"
  }), { occurrenceIndex: 0, questionIndex: 0 });
});

test("M2 restores only its own Module attempt cursor", () => {
  const module2Occurrences = [
    { occurrenceId: "m2-ctw", logicalItemId: "m2-ctw-item", taskType: "ctw", sourceQuestionStart: 36, sourceQuestionEnd: 45 },
    { occurrenceId: "m2-rdl", logicalItemId: "m2-rdl-item", taskType: "rdl", sourceQuestionStart: 46, sourceQuestionEnd: 47 }
  ];
  const module2 = moduleAttempt({
    currentOccurrenceId: "m2-rdl",
    currentQuestionIndex: 1,
    moduleAttemptId: "module-2",
    moduleNumber: 2,
    timeLimitSeconds: 540
  });
  const occurrence = readingFullSetBootstrapOccurrence(module2Occurrences, module2);
  assert.equal(occurrence.occurrenceId, "m2-rdl");
  assert.deepEqual(readingFullSetRestoredPosition({
    moduleAttempt: module2,
    occurrences: module2Occurrences,
    questionCount: 2,
    restoredOccurrenceId: occurrence.occurrenceId
  }), { occurrenceIndex: 1, questionIndex: 1 });
  assert.equal(module2Occurrences.some((candidate) => candidate.occurrenceId === "m1-rap"), false);
});

test("preparing Module ignores any cursor and submitted Module never becomes a runner cursor", () => {
  const preparing = moduleAttempt({
    currentOccurrenceId: "m1-rap",
    currentQuestionIndex: 3,
    deadlineAt: null,
    startedAt: null,
    status: "preparing"
  });
  assert.equal(readingFullSetBootstrapOccurrence(occurrences, preparing).occurrenceId, "m1-ctw");
  const submitted = moduleAttempt({ status: "submitted" });
  assert.equal(readingFullSetBootstrapOccurrence(occurrences, submitted).occurrenceId, "m1-ctw");
});

test("cursor queue serializes writes, coalesces rapid navigation, and durably ends at latest", async () => {
  let releaseFirst;
  const writes = [];
  const queue = new ReadingFullSetCursorQueue({
    maxRetries: 0,
    transport: async (snapshot) => {
      writes.push(snapshot);
      if (writes.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
    }
  });
  queue.prime("module-1", 7);
  const first = queue.enqueue({ moduleAttemptId: "module-1", moduleNumber: 1, occurrenceId: "m1-rdl", questionIndex: 0 });
  queue.enqueue({ moduleAttemptId: "module-1", moduleNumber: 1, occurrenceId: "m1-rdl", questionIndex: 1 });
  const latest = queue.enqueue({ moduleAttemptId: "module-1", moduleNumber: 1, occurrenceId: "m1-rdl", questionIndex: 0 });
  await Promise.resolve();
  assert.deepEqual(writes.map((write) => write.cursorRevision), [8]);
  releaseFirst();
  while (writes.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes.map((write) => write.cursorRevision), [8, 10]);
  assert.equal(writes[1].questionIndex, 0);
  assert.equal(first.cursorRevision, 8);
  assert.equal(latest.cursorRevision, 10);
});

test("cursor schema and RPC are module-scoped, ownership checked, and stale-safe", () => {
  assert.match(migration, /current_occurrence_id text/);
  assert.match(migration, /current_question_index integer/);
  assert.match(migration, /cursor_revision bigint not null default 0/);
  assert.match(migration, /attempt_id = p_attempt_id and student_id = v_user_id/);
  assert.match(migration, /module_number = p_module_number/);
  assert.match(migration, /v_attempt\.status <> 'in_progress' or v_module\.status <> 'active'/);
  assert.match(migration, /occurrence\.source_module = case p_module_number when 1 then 'm1' else 'm2' end/);
  assert.match(migration, /v_item\.module = 'ctw' and p_question_index <> 0/);
  assert.match(migration, /v_item\.module <> 'ctw' and p_question_index >= v_item\.question_count/);
  assert.match(migration, /p_cursor_revision <= v_module\.cursor_revision/);
  assert.ok(migration.indexOf("p_cursor_revision <= v_module.cursor_revision") < migration.indexOf("set current_occurrence_id = p_occurrence_id"));
  assert.match(migration, /'currentOccurrenceId', module_attempt\.current_occurrence_id/);
  assert.match(migration, /'currentQuestionIndex', module_attempt\.current_question_index/);
  assert.match(migration, /'cursorRevision', module_attempt\.cursor_revision/);
  assert.match(cursorRoute, /update_reading_full_set_navigation_cursor/);
});

test("all bootstrap paths resolve the active Module cursor and load that occurrence payload", () => {
  for (const route of [resumeRoute, m1Route, m2Route]) {
    assert.match(route, /readingFullSetBootstrapOccurrence/);
    assert.match(route, /loadReadingFullSetOccurrencePracticePayload/);
  }
  assert.match(runner, /readingFullSetRestoredPosition/);
  assert.match(runner, /questionCount: bootstrap\.firstOccurrence\.practice\.questions\.length/);
});

test("navigation cursor persistence is independent and outside the navigation critical path", () => {
  const move = runner.slice(runner.indexOf("const move = useCallback"), runner.indexOf("const leavePractice"));
  assert.match(move, /setPosition\(nextPosition\);[\s\S]*enqueueCursor\(moduleAttempt, nextOccurrence\.occurrenceId, nextPosition\.questionIndex\)/);
  assert.doesNotMatch(move, /await\s+enqueueCursor|await\s+fetch/);
  assert.match(runner, /new ReadingFullSetCursorQueue/);
  assert.match(runner, /cursorQueueRef\.current\?\.flushBestEffort/);
  assert.match(runner, /keepalive: true/);
});

test("restored occurrence drives existing one-ahead prefetch and keeps load lease behavior", () => {
  const prefetch = runner.slice(
    runner.indexOf("interactiveOccurrenceId !== currentOccurrence.occurrenceId"),
    runner.indexOf("const commitActiveQuestionTime")
  );
  assert.match(prefetch, /runner\.occurrences\[position\.occurrenceIndex \+ 1\]/);
  assert.match(prefetch, /acquireOccurrence\([\s\S]*prefetch: true/);
  assert.match(runner, /initialPause = await beginLoadPause\(token, null\)[\s\S]*await loadRunner\(token\)/);
  assert.match(runner, /moduleAttempt\.status === "active"[\s\S]*finishLoadPause\(accessToken, pause\.loadId\)/);
});
