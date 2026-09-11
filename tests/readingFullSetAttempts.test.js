const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  moveReadingFullSetPosition,
  readingFullSetAttemptPhase,
  readingFullSetDisplayRange,
  readingFullSetPrepAction,
  readingFullSetRemainingSeconds
} = require("../lib/reading/fullSetAttempts.ts");
const { buildReadingSubmissionAnswers } = require("../lib/reading/attempts.ts");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("supabase/reading_full_set_attempts.sql");
const retakeHotfix = read("supabase/reading_full_set_retake_hotfix.sql");
const attemptRoute = read("app/api/reading/full-set-attempts/route.ts");
const runnerRoute = read("app/api/reading/full-set-attempts/[attemptId]/route.ts");
const occurrenceRoute = read("app/api/reading/full-set-attempts/[attemptId]/occurrences/[occurrenceId]/route.ts");
const submitRoute = read("app/api/reading/full-set-attempts/[attemptId]/modules/[moduleNumber]/submit/route.ts");
const runnerUi = read("components/reading/ReadingFullSetRunner.tsx");
const existingRuntime = read("components/reading/ReadingPractice.tsx");

function moduleAttempt(moduleNumber, status = "active") {
  return {
    moduleAttemptId: `module-${moduleNumber}`,
    moduleNumber,
    status,
    timeLimitSeconds: moduleNumber === 1 ? 1230 : 540,
    startedAt: "2026-08-30T00:00:00.000Z",
    deadlineAt: "2026-08-30T00:20:30.000Z",
    submittedAt: status === "submitted" ? "2026-08-30T00:10:00.000Z" : null,
    submissionReason: status === "submitted" ? "manual" : null,
    answerRevision: 0,
    totalPoints: status === "submitted" ? (moduleNumber === 1 ? 35 : 15) : 0,
    correctPoints: 0
  };
}

function attempt(overrides = {}) {
  return {
    attemptId: "00000000-0000-4000-8000-000000000001",
    fullSetId: "20260601A",
    status: "in_progress",
    currentModule: 1,
    startedAt: "2026-08-30T00:00:00.000Z",
    completedAt: null,
    serverNow: "2026-08-30T00:00:00.000Z",
    module1: moduleAttempt(1),
    module2: null,
    ...overrides
  };
}

test("Prep state maps active and transition states without exposing internal status labels", () => {
  assert.deepEqual(readingFullSetPrepAction(null), { label: "开始 Module 1", action: "start_module_1" });
  assert.equal(readingFullSetPrepAction(attempt()).label, "继续 Module 1");
  const m2Ready = attempt({ currentModule: 2, module1: moduleAttempt(1, "submitted") });
  assert.equal(readingFullSetAttemptPhase(m2Ready), "module_2_ready");
  assert.equal(readingFullSetPrepAction(m2Ready).label, "开始 Module 2");
  const m2Active = attempt({ currentModule: 2, module1: moduleAttempt(1, "submitted"), module2: moduleAttempt(2) });
  assert.equal(readingFullSetPrepAction(m2Active).label, "继续 Module 2");
  const completed = attempt({ status: "completed", currentModule: 2, completedAt: "2026-08-30T01:00:00.000Z", module1: moduleAttempt(1, "submitted"), module2: moduleAttempt(2, "submitted") });
  assert.equal(readingFullSetPrepAction(completed).label, "练习已完成");
});

test("server deadline survives refresh and client display counts down from server time", () => {
  const deadlineAt = "2026-08-30T00:20:30.000Z";
  assert.equal(readingFullSetRemainingSeconds({ deadlineAt, serverNow: "2026-08-30T00:00:00.000Z", clientNowAtSyncMs: 10_000, clientNowMs: 10_000 }), 1230);
  assert.equal(readingFullSetRemainingSeconds({ deadlineAt, serverNow: "2026-08-30T00:00:00.000Z", clientNowAtSyncMs: 10_000, clientNowMs: 25_000 }), 1215);
  assert.equal(readingFullSetRemainingSeconds({ deadlineAt, serverNow: "2026-08-30T00:05:00.000Z", clientNowAtSyncMs: 50_000, clientNowMs: 50_000 }), 930);
});

test("Module navigation crosses CTW, RDL, and RAP using source question ranges", () => {
  const occurrences = [
    { occurrenceId: "ctw", logicalItemId: "ctw-item", taskType: "ctw", sourceQuestionStart: 1, sourceQuestionEnd: 10 },
    { occurrenceId: "rdl", logicalItemId: "rdl-item", taskType: "rdl", sourceQuestionStart: 11, sourceQuestionEnd: 12 },
    { occurrenceId: "rap", logicalItemId: "rap-item", taskType: "rap", sourceQuestionStart: 13, sourceQuestionEnd: 17 }
  ];
  assert.deepEqual(readingFullSetDisplayRange(occurrences[0], 0), { start: 1, end: 10 });
  assert.deepEqual(moveReadingFullSetPosition(occurrences, { occurrenceIndex: 0, questionIndex: 0 }, 1), { occurrenceIndex: 1, questionIndex: 0 });
  assert.deepEqual(readingFullSetDisplayRange(occurrences[1], 0), { start: 11, end: 11 });
  assert.deepEqual(moveReadingFullSetPosition(occurrences, { occurrenceIndex: 1, questionIndex: 0 }, -1), { occurrenceIndex: 0, questionIndex: 0 });
  assert.deepEqual(moveReadingFullSetPosition(occurrences, { occurrenceIndex: 1, questionIndex: 1 }, 1), { occurrenceIndex: 2, questionIndex: 0 });
});

test("CTW, RDL, and RAP submissions preserve canonical scoring identities", () => {
  const ctwSlots = Array.from({ length: 10 }, (_, index) => ({ slotId: `slot-${index + 1}`, slotOrder: index + 1, missingLength: 1 }));
  const ctwPractice = { item: { module: "ctw" }, questions: [{ questionId: "ctw-question", questionType: "ctw", slots: ctwSlots }] };
  const ctwAnswers = { "ctw-question": { kind: "ctw", slots: Object.fromEntries(ctwSlots.map((slot) => [slot.slotId, ["a"]])) } };
  const ctw = buildReadingSubmissionAnswers(ctwPractice, ctwAnswers, {});
  assert.equal(ctw.length, 10);
  assert.deepEqual(ctw.map((answer) => [answer.questionId, answer.slotId]), ctwSlots.map((slot) => ["ctw-question", slot.slotId]));

  const rdlPractice = { item: { module: "rdl" }, questions: [
    { questionId: "rdl-q1", questionType: "rdl" },
    { questionId: "rdl-q2", questionType: "rdl" }
  ] };
  const rdl = buildReadingSubmissionAnswers(rdlPractice, { "rdl-q1": { kind: "choice", optionId: "option-a" } }, {});
  assert.deepEqual(rdl.map((answer) => answer.questionId), ["rdl-q1", "rdl-q2"]);

  const rapPractice = { item: { module: "rap" }, questions: [
    { questionId: "rap-q1", questionType: "rap_multiple_choice" },
    { questionId: "rap-q2", questionType: "rap_sentence_insertion" },
    { questionId: "rap-q3", questionType: "rap_sentence_selection" }
  ] };
  const rap = buildReadingSubmissionAnswers(rapPractice, {
    "rap-q1": { kind: "choice", optionId: "option-b" },
    "rap-q2": { kind: "insertion", anchorId: "anchor-c" },
    "rap-q3": { kind: "sentence_selection", sentenceId: "sentence-d" }
  }, {});
  assert.deepEqual(rap.map((answer) => [answer.questionId, answer.kind]), [
    ["rap-q1", "option"],
    ["rap-q2", "insertion_anchor"],
    ["rap-q3", "sentence_selection"]
  ]);
});

test("migration makes Start idempotent and assigns authoritative Module deadlines", () => {
  assert.match(migration, /create unique index if not exists reading_full_set_one_active_attempt[\s\S]*where status = 'in_progress'/);
  assert.match(migration, /on conflict \(student_id, full_set_id\) where status = 'in_progress' do nothing/);
  assert.match(migration, /where student_id = v_user_id[\s\S]*full_set_id = p_full_set_id[\s\S]*status = 'in_progress'[\s\S]*if v_attempt_id is null then/);
  assert.match(migration, /return 1230/);
  assert.match(migration, /return 1110/);
  assert.match(migration, /return 540/);
  assert.match(migration, /deadline_at = started_at \+ make_interval\(secs => time_limit_seconds\)/);
  assert.match(migration, /v_now \+ make_interval\(secs => v_time_limit\)/);
  assert.match(migration, /reading_full_set_module_time_limit\(p_full_set_id, 1::smallint\)/);
  assert.match(migration, /reading_full_set_module_time_limit\(p_full_set_id, 2::smallint\)/);
  assert.match(migration, /reading_full_set_module_time_limit\(v_attempt\.full_set_id, 2::smallint\)/);
  assert.match(retakeHotfix, /and status = 'in_progress'[\s\S]*if v_attempt_id is null then/);
  assert.match(retakeHotfix, /on conflict \(student_id, full_set_id\) where status = 'in_progress' do nothing/);
});

test("M1 lock, timeout reconciliation, manual submit, and M2 completion are server rules", () => {
  assert.match(migration, /if v_module\.status <> 'active'[\s\S]*'reason', 'locked'/);
  assert.match(migration, /v_module\.deadline_at <= v_now[\s\S]*'timeout'/);
  assert.match(migration, /if v_module\.status = 'submitted' then return; end if/);
  assert.match(migration, /alreadySubmitted/);
  assert.match(migration, /v_module_1_status <> 'submitted'/);
  assert.match(migration, /set status = 'completed', current_module = 2, completed_at/);
  const m1Creation = migration.slice(
    migration.indexOf("create or replace function public.get_or_create_reading_full_set_attempt"),
    migration.indexOf("create or replace function public.get_reading_full_set_attempt(")
  );
  assert.match(m1Creation, /module_number, status, time_limit_seconds/);
  assert.match(m1Creation, /v_attempt_id, 1, 'active'/);
  assert.doesNotMatch(m1Creation, /v_attempt_id, 2, 'active'/);
});

test("answer mutation uses ownership, active lock, deadline, occurrence identity, and revision checks", () => {
  const saveFunction = migration.slice(
    migration.indexOf("create or replace function public.save_reading_full_set_occurrence_answers"),
    migration.indexOf("create or replace function public.submit_reading_full_set_module")
  );
  assert.match(saveFunction, /attempt_id = p_attempt_id and student_id = v_user_id/);
  assert.match(saveFunction, /p_expected_revision <> v_module\.answer_revision/);
  assert.match(saveFunction, /public\.reading_occurrence_full_set_id[\s\S]*= v_attempt\.full_set_id/);
  assert.match(saveFunction, /delete from public\.reading_full_set_answers/);
  assert.match(saveFunction, /set answer_revision = answer_revision \+ 1/);
});

test("student APIs enforce ownership and do not expose answer keys or the next Module payload", () => {
  for (const source of [attemptRoute, runnerRoute, occurrenceRoute, submitRoute]) {
    assert.match(source, /requireReadingFullSetStudent/);
  }
  assert.match(runnerRoute, /loadOwnedReadingFullSetAttempt/);
  assert.match(occurrenceRoute, /loadOwnedReadingFullSetAttempt/);
  assert.match(occurrenceRoute, /select\("question_id,slot_id,answer_kind,student_answer,question_time_seconds"\)/);
  assert.doesNotMatch(occurrenceRoute, /correct_option_id|correct_anchor_id|correct_sentence_id|missing_text/);
  assert.match(runnerRoute, /buildReadingFullSetRunnerPayload/);
});

test("Full Set runner reuses the existing three-type workspace and implements autosave and server submit", () => {
  assert.match(existingRuntime, /export function ReadingWorkspaceRouter/);
  assert.match(runnerUi, /<ReadingWorkspaceRouter/);
  assert.match(runnerUi, /buildReadingSubmissionAnswers/);
  assert.match(runnerUi, /setTimeout[\s\S]*600/);
  assert.match(runnerUi, /expectedRevision: revisionRef\.current/);
  assert.match(runnerUi, /full-set-attempts.*modules\/\$\{moduleNumber\}\/submit/);
  assert.match(runnerUi, /Time Left/i);
  assert.match(runnerUi, /Questions \$\{displayRange\.start\}–\$\{displayRange\.end\}/);
  assert.match(runnerUi, /开始 Module 2/);
});
