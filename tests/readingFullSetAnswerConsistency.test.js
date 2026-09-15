const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  mergeReadingFullSetAnswers,
  sameReadingFullSetAnswerValues
} = require("../lib/reading/fullSetAnswerMerge.ts");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("supabase/reading_full_set_answer_consistency_20260915.sql");
const runner = read("components/reading/ReadingFullSetRunner.tsx");
const occurrenceRoute = read("app/api/reading/full-set-attempts/[attemptId]/occurrences/[occurrenceId]/route.ts");
const submitRoute = read("app/api/reading/full-set-attempts/[attemptId]/modules/[moduleNumber]/submit/route.ts");

function answer(questionId, studentAnswer, overrides = {}) {
  return {
    kind: "option",
    questionId,
    questionTimeSeconds: 1,
    studentAnswer,
    ...overrides
  };
}

test("same-page stale timing differences merge silently and preserve the latest time", () => {
  const result = mergeReadingFullSetAnswers({
    base: [answer("q1", "a", { questionTimeSeconds: 2 })],
    local: [answer("q1", "a", { questionTimeSeconds: 7 })],
    server: [answer("q1", "a", { questionTimeSeconds: 4 })]
  });
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.merged[0].studentAnswer, "a");
  assert.equal(result.merged[0].questionTimeSeconds, 7);
});

test("disjoint CTW slot changes merge while a same-slot concurrent edit conflicts", () => {
  const base = [
    answer("ctw", null, { kind: "ctw_slot", slotId: "s1" }),
    answer("ctw", null, { kind: "ctw_slot", slotId: "s2" })
  ];
  const disjoint = mergeReadingFullSetAnswers({
    base,
    local: [
      answer("ctw", "cat", { kind: "ctw_slot", slotId: "s1" }),
      base[1]
    ],
    server: [
      base[0],
      answer("ctw", "dog", { kind: "ctw_slot", slotId: "s2" })
    ]
  });
  assert.deepEqual(disjoint.conflicts, []);
  assert.deepEqual(disjoint.merged.map((entry) => entry.studentAnswer), ["cat", "dog"]);

  const conflict = mergeReadingFullSetAnswers({
    base: [base[0]],
    local: [answer("ctw", "cat", { kind: "ctw_slot", slotId: "s1" })],
    server: [answer("ctw", "dog", { kind: "ctw_slot", slotId: "s1" })]
  });
  assert.equal(conflict.conflicts.length, 1);
});

test("RDL and all RAP answer kinds use answer values, not timer state, for conflicts", () => {
  for (const candidate of [
    answer("rdl", "option-a"),
    answer("rap-mc", "option-b"),
    answer("rap-insert", "anchor-2", { kind: "insertion_anchor" }),
    answer("rap-select", "sentence-3", { kind: "sentence_selection" })
  ]) {
    assert.equal(sameReadingFullSetAnswerValues([candidate], [{ ...candidate, questionTimeSeconds: 99 }]), true);
    const result = mergeReadingFullSetAnswers({
      base: [{ ...candidate, studentAnswer: null }],
      local: [candidate],
      server: [{ ...candidate, studentAnswer: "other" }]
    });
    assert.equal(result.conflicts.length, 1);
  }
});

test("answer, cursor, timer, and load revisions are structurally independent", () => {
  assert.match(migration, /reading_full_set_occurrence_revisions/);
  assert.match(migration, /p_expected_occurrence_revision <> v_occurrence_revision/);
  assert.doesNotMatch(migration.slice(
    migration.indexOf("save_reading_full_set_occurrence_answers_v2"),
    migration.indexOf("submit_reading_full_set_module_v2")
  ), /timer_revision|cursor_revision|load_id/);
  const applyRunner = runner.slice(runner.indexOf("const applyRunner"), runner.indexOf("const applyBootstrap"));
  assert.doesNotMatch(applyRunner, /Math\.max\([^)]*answerRevision/);
  assert.match(applyRunner, /previousModuleKey !== nextModuleKey[\s\S]*answerRevisionRef\.current/);
});

test("occurrence endpoint exposes authoritative stale state and supports the scoped CAS migration", () => {
  assert.match(occurrenceRoute, /save_reading_full_set_occurrence_answers_v2/);
  assert.match(occurrenceRoute, /serverAnswers: submittedAnswers\(saved\.data\)/);
  assert.match(occurrenceRoute, /sameReadingFullSetAnswers/);
  assert.match(migration, /v_module\.status not in \('active', 'paused'\)/);
});

test("confirmed submit freezes all loaded answers and uses an atomic answer-revision barrier", () => {
  const submit = runner.slice(runner.indexOf("const submitModule"), runner.indexOf("useEffect(() => {", runner.indexOf("const submitModule")));
  assert.match(submit, /if \(!activeRunner \|\| submittingRef\.current\) return/);
  assert.match(submit, /stageModuleAnswerSnapshot[\s\S]*await flushPendingSave/);
  assert.match(submit, /expectedAnswerRevision: answerRevisionRef\.current/);
  assert.match(submitRoute, /submit_reading_full_set_module_v2/);
  assert.match(migration, /p_expected_answer_revision <> v_module\.answer_revision/);
});

test("genuine conflicts have two recovery actions and do not permanently lock submit", () => {
  assert.match(runner, /keepLocalConflictAnswers[\s\S]*saveQueueRef\.current\?\.retry/);
  assert.match(runner, /useServerConflictAnswers[\s\S]*saveQueueRef\.current\?\.discard/);
  assert.match(runner, /请先选择保留本页答案或服务器答案，再重新提交/);
});

test("pagehide starts answer durability before pause and paused modules accept the pending save", () => {
  const leaving = runner.slice(runner.indexOf("const saveBeforeLeaving"), runner.indexOf("const move = useCallback"));
  assert.ok(leaving.indexOf("flushPendingSave") < leaving.indexOf("pauseActiveModule"));
  assert.match(migration, /v_module\.status not in \('active', 'paused'\)/);
});
