const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  moveReadingFullSetPosition,
  isReadingFullSetAttemptSummary,
  readingFullSetActiveModuleAttempt,
  readingFullSetAttemptPhase,
  readingFullSetDisplayRange,
  readingFullSetPrepAction,
  readingFullSetRemainingSeconds,
  readingFullSetRunnerModuleKey
} = require("../lib/reading/fullSetAttempts.ts");
const { buildReadingSubmissionAnswers } = require("../lib/reading/attempts.ts");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("supabase/reading_full_set_attempts.sql");
const loadingPauseHotfix = read("supabase/reading_full_set_loading_pause_hotfix_20260911.sql");
const lifecycleMigration = read("supabase/reading_full_set_preparing_load_lease_20260914.sql");
const retakeHotfix = read("supabase/reading_full_set_retake_hotfix.sql");
const attemptRoute = read("app/api/reading/full-set-attempts/route.ts");
const runnerRoute = read("app/api/reading/full-set-attempts/[attemptId]/route.ts");
const occurrenceRoute = read("app/api/reading/full-set-attempts/[attemptId]/occurrences/[occurrenceId]/route.ts");
const submitRoute = read("app/api/reading/full-set-attempts/[attemptId]/modules/[moduleNumber]/submit/route.ts");
const runnerUi = read("components/reading/ReadingFullSetRunner.tsx");
const detailUi = read("components/reading/ReadingFullSetDetail.tsx");
const loadPauseRoute = read("app/api/reading/full-set-attempts/[attemptId]/loads/route.ts");
const loadPauseFinishRoute = read("app/api/reading/full-set-attempts/[attemptId]/loads/[loadId]/route.ts");
const activateRoute = read("app/api/reading/full-set-attempts/[attemptId]/modules/[moduleNumber]/activate/route.ts");
const existingRuntime = read("components/reading/ReadingPractice.tsx");

function moduleAttempt(moduleNumber, status = "active") {
  return {
    moduleAttemptId: `module-${moduleNumber}`,
    moduleNumber,
    status,
    timeLimitSeconds: moduleNumber === 1 ? 1230 : 540,
    startedAt: status === "preparing" ? null : "2026-08-30T00:00:00.000Z",
    deadlineAt: status === "preparing" ? null : "2026-08-30T00:20:30.000Z",
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
  const preparingM1 = attempt({ module1: moduleAttempt(1, "preparing") });
  assert.equal(readingFullSetAttemptPhase(preparingM1), "module_1_preparing");
  assert.equal(readingFullSetPrepAction(preparingM1).label, "继续 Module 1");
  assert.equal(isReadingFullSetAttemptSummary(preparingM1), true);
  const m2Ready = attempt({ currentModule: 2, module1: moduleAttempt(1, "submitted") });
  assert.equal(readingFullSetAttemptPhase(m2Ready), "module_2_ready");
  assert.equal(readingFullSetPrepAction(m2Ready).label, "开始 Module 2");
  const m2Active = attempt({ currentModule: 2, module1: moduleAttempt(1, "submitted"), module2: moduleAttempt(2) });
  assert.equal(readingFullSetPrepAction(m2Active).label, "继续 Module 2");
  const m2Preparing = attempt({ currentModule: 2, module1: moduleAttempt(1, "submitted"), module2: moduleAttempt(2, "preparing") });
  assert.equal(readingFullSetAttemptPhase(m2Preparing), "module_2_preparing");
  const recoverableM2 = { ...m2Active, currentModule: 1 };
  assert.equal(readingFullSetAttemptPhase(recoverableM2), "module_2_active");
  assert.equal(readingFullSetActiveModuleAttempt(recoverableM2).moduleNumber, 2);
  assert.equal(readingFullSetRunnerModuleKey(recoverableM2), "module-2");
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

test("M1 and M2 bootstrap stay preparing until server activation grants the full limit", () => {
  assert.match(lifecycleMigration, /status in \('preparing', 'active', 'submitted'\)/);
  assert.match(lifecycleMigration, /v_attempt_id, 1, 'preparing', v_time_limit, null, null/);
  assert.match(lifecycleMigration, /p_attempt_id, 2, 'preparing', v_time_limit, null, null/);
  assert.match(lifecycleMigration, /v_activated_at := clock_timestamp\(\);[\s\S]*deadline_at = v_activated_at \+ make_interval\(secs => time_limit_seconds\)/);
  const activationFunction = lifecycleMigration.slice(
    lifecycleMigration.indexOf("create or replace function public.activate_reading_full_set_module"),
    lifecycleMigration.indexOf("create or replace function public.get_or_create_reading_full_set_attempt")
  );
  assert.doesNotMatch(activationFunction, /v_now timestamptz := clock_timestamp\(\)/);
  assert.match(migration, /return 1230/);
  assert.match(migration, /return 1110/);
  assert.match(migration, /return 540/);
  assert.equal(readingFullSetRemainingSeconds({ deadlineAt: "2026-09-14T00:23:30Z", serverNow: "2026-09-14T00:03:00Z", clientNowAtSyncMs: 0, clientNowMs: 0 }), 1230);
  assert.equal(readingFullSetRemainingSeconds({ deadlineAt: "2026-09-14T00:12:00Z", serverNow: "2026-09-14T00:03:00Z", clientNowAtSyncMs: 0, clientNowMs: 0 }), 540);
  assert.match(activateRoute, /activate_reading_full_set_module/);
});

test("M1 lock, timeout reconciliation, manual submit, and M2 completion are server rules", () => {
  assert.match(migration, /if v_module\.status <> 'active'[\s\S]*'reason', 'locked'/);
  assert.match(migration, /v_module\.deadline_at <= v_now[\s\S]*'timeout'/);
  assert.match(migration, /if v_module\.status = 'submitted' then return; end if/);
  assert.match(migration, /alreadySubmitted/);
  assert.match(migration, /v_module_1_status <> 'submitted'/);
  assert.match(migration, /set status = 'completed', current_module = 2, completed_at/);
  const m1Creation = lifecycleMigration.slice(
    lifecycleMigration.indexOf("create or replace function public.get_or_create_reading_full_set_attempt"),
    lifecycleMigration.indexOf("create or replace function public.prepare_reading_full_set_module_2")
  );
  assert.match(m1Creation, /module_number, status, time_limit_seconds/);
  assert.match(m1Creation, /v_attempt_id, 1, 'preparing'/);
  assert.doesNotMatch(m1Creation, /v_attempt_id, 2, 'active'/);
  const startM2 = lifecycleMigration.slice(
    lifecycleMigration.indexOf("create or replace function public.prepare_reading_full_set_module_2"),
    lifecycleMigration.indexOf("create or replace function public.start_reading_full_set_module_2")
  );
  assert.match(startM2, /insert into public\.reading_full_set_module_attempts[\s\S]*2, 'preparing'/);
  assert.doesNotMatch(startM2, /insert into public\.reading_full_set_load_pauses/);
  assert.match(startM2, /update public\.reading_full_set_attempts[\s\S]*set current_module = 2/);
  assert.match(lifecycleMigration, /if v_module\.status <> 'active' or v_module\.deadline_at is null then[\s\S]*FULL_SET_MODULE_NOT_ACTIVE/);
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
  assert.match(read("lib/reading/fullSetAttemptServer.ts"), /readingFullSetCurrentModuleAttempt\(attempt\)[\s\S]*currentModule\?\.moduleNumber === 2[\s\S]*fullSet\.module2\.occurrences/);
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

test("normal Full Set autosave is silent and does not disable navigation", () => {
  assert.doesNotMatch(runnerUi, /正在保存答案|保存中|已保存/);
  assert.doesNotMatch(runnerUi, /disabled=\{[^}]*saving/);
  assert.match(runnerUi, /pendingSaveRef/);
  assert.match(runnerUi, /saveChainRef/);
  assert.match(runnerUi, /答案保存失败，请检查网络后重试。/);
});

test("same-route M2 transition invalidates M1 state and reloads the server runner", () => {
  assert.match(runnerUi, /readingFullSetRunnerModuleKey\(current\.attempt\)[\s\S]*readingFullSetRunnerModuleKey\(attempt\)/);
  assert.match(runnerUi, /occurrences: moduleChanged \? \[\] : current\.occurrences/);
  assert.match(runnerUi, /moduleAttemptId: moduleAttempt\.moduleAttemptId/);
  assert.match(runnerUi, /readingFullSetRunnerModuleKey\(activeRunner\.attempt\) !== pending\.moduleAttemptId/);
  assert.match(runnerUi, /if \(submittingRef\.current\) return/);
  assert.match(runnerUi, /runnerGenerationRef\.current \+= 1/);
  assert.match(runnerUi, /occurrenceRequestRef\.current \+= 1/);
  assert.match(runnerUi, /module_2_preparing[\s\S]*applyAttempt\(result\.attempt\)[\s\S]*loadRunner\(accessToken\)/);
});

test("occurrence loading has loaded/error convergence and Retry refreshes server truth", () => {
  assert.match(runnerUi, /type OccurrenceLoadState/);
  assert.match(runnerUi, /message: "题目加载失败，请重试。", status: "error"/);
  assert.match(runnerUi, />\s*重试\s*</);
  assert.match(runnerUi, /retryOccurrence[\s\S]*beginLoadPause\(accessToken, occurrenceId\)[\s\S]*loadRunner\(accessToken\)/);
  assert.match(runnerUi, /requestId !== occurrenceRequestRef\.current \|\| generation !== runnerGenerationRef\.current/);
});

test("a 90-second active occurrence load is fully covered by renewable server leases", () => {
  assert.match(lifecycleMigration, /create or replace function public\.renew_reading_full_set_load_pause/);
  assert.match(lifecycleMigration, /v_new_expires_at := v_now \+ interval '45 seconds'/);
  assert.match(lifecycleMigration, /least\(greatest\(p_finished_at, v_pause\.started_at\), v_pause\.expires_at\) - v_pause\.started_at/);
  assert.match(lifecycleMigration, /deadline_at = deadline_at \+ make_interval/);
  assert.match(lifecycleMigration, /credited_milliseconds[\s\S]*v_deadline_delta := v_compensated - v_pause\.credited_milliseconds/);
  assert.match(lifecycleMigration, /set deadline_at = deadline_at \+ interval '45 seconds'/);
  assert.doesNotMatch(lifecycleMigration, /300000 - v_already_compensated|least\(v_compensated, 45000\)|pause_limit/);
  assert.match(runnerUi, /window\.setInterval\(\(\) => void renew\(\), 15_000\)/);
  assert.match(loadPauseFinishRoute, /export async function PATCH[\s\S]*renew_reading_full_set_load_pause/);
});

test("heartbeat loss expires protection after the 45-second stale lease TTL", () => {
  assert.match(lifecycleMigration, /expires_at <= last_renewed_at \+ interval '45 seconds'/);
  assert.match(lifecycleMigration, /if v_pause\.expires_at <= v_now then[\s\S]*settle_reading_full_set_load_pause\(p_load_id, v_pause\.expires_at\)/);
  assert.match(lifecycleMigration, /if v_open_pause\.expires_at > v_now then return; end if/);
  assert.match(runnerUi, /server-issued 45-second TTL ends the protected interval/);
});

test("duplicate begin, heartbeat, and finish calls cannot compensate twice", () => {
  assert.match(lifecycleMigration, /where load_id = p_load_id;[\s\S]*if found then[\s\S]*already_finished/);
  assert.match(lifecycleMigration, /last_renewed_at > v_now - interval '5 seconds'/);
  assert.match(lifecycleMigration, /if v_pause\.finished_at is not null then return; end if/);
  assert.match(lifecycleMigration, /if v_pause\.finished_at is not null then[\s\S]*'renewed', false/);
  assert.match(loadPauseRoute, /begin_reading_full_set_load_pause/);
  assert.match(loadPauseFinishRoute, /finish_reading_full_set_load_pause/);
  assert.match(lifecycleMigration, /last_renewed_at <= v_now - interval '5 seconds'[\s\S]*renewal_count = renewal_count \+ 1/);
});

test("multiple tabs share the one open module lease instead of creating parallel leases", () => {
  assert.match(migration, /create unique index if not exists reading_full_set_one_open_load_pause[\s\S]*where finished_at is null/);
  assert.match(lifecycleMigration, /where module_attempt_id = v_module\.module_attempt_id and finished_at is null[\s\S]*'loadId', v_existing\.load_id/);
  assert.match(lifecycleMigration, /create or replace function public\.timeout_reading_full_set_module[\s\S]*perform public\.reconcile_reading_full_set_attempt/);
  assert.match(submitRoute, /timeoutOnly[\s\S]*timeout_reading_full_set_module/);
  assert.match(runnerUi, /timeoutRetryAfterRef/);
  assert.match(runnerUi, /if \(result\.attempt\) applyAttempt\(result\.attempt\)/);
});

test("preparing refresh preserves the module attempt and activation is one-way/idempotent", () => {
  assert.match(lifecycleMigration, /on conflict \(student_id, full_set_id\) where status = 'in_progress' do nothing/);
  assert.match(lifecycleMigration, /on conflict \(attempt_id, module_number\) do nothing/);
  assert.match(lifecycleMigration, /if v_module\.status = 'active' then[\s\S]*return public\.reading_full_set_attempt_json/);
  assert.match(lifecycleMigration, /where module_attempt_id = v_module\.module_attempt_id and status = 'preparing'/);
});

test("RDL load lease finishes only after image decode and interactive selection geometry", () => {
  assert.match(existingRuntime, /typeof image\.decode === "function"[\s\S]*await image\.decode\(\)/);
  assert.match(existingRuntime, /assetStatus === "ready" && bindingValid && selectionRect\?\.width && selectionRect\.height[\s\S]*onReady\?\.\(\)/);
  assert.match(runnerUi, /onReady=\{handleWorkspaceReady\}/);
  const payloadAssignment = runnerUi.indexOf("setOccurrencePayloads");
  const readyFinish = runnerUi.indexOf("const handleWorkspaceReady");
  assert.ok(payloadAssignment >= 0 && readyFinish > payloadAssignment);
  assert.match(runnerUi, /workspaceInteractive = currentModuleAttempt\?\.status === "active"[\s\S]*readOnly=\{!workspaceInteractive\}/);
});

test("submitted modules cannot activate, submit twice for points, or create leases", () => {
  assert.match(lifecycleMigration, /if v_module\.status <> 'preparing' then[\s\S]*FULL_SET_MODULE_NOT_PREPARING/);
  assert.match(lifecycleMigration, /where attempt_id = p_attempt_id and status = 'active'/);
  assert.match(lifecycleMigration, /if v_module\.status = 'submitted' then[\s\S]*alreadySubmitted/);
  assert.match(lifecycleMigration, /if v_module\.status <> 'active' or v_module\.deadline_at is null then/);
});

test("Prep refreshes authoritative attempt state so active M2 is never labeled as M1", () => {
  assert.match(detailUi, /refreshOnMount: true/);
});
