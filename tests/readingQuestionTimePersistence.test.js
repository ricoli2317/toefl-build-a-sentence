const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { buildReadingResultPayload } = require("../lib/reading/history.ts");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const baseSchema = read("supabase/reading_attempts.sql");
const migration = read("supabase/reading_question_time_persistence.sql");
const submitRoute = read("app/api/reading/attempts/[attemptId]/submit/route.ts");
const resultRoute = read("app/api/reading/results/[attemptId]/route.ts");
const practiceUi = read("components/reading/ReadingPractice.tsx");
const resultUi = read("components/reading/ReadingResult.tsx");
const resultSession = read("lib/reading/resultSession.ts");

test("question time migration is nullable and leaves historical rows untouched", () => {
  assert.match(migration, /add column if not exists question_time_seconds integer/);
  assert.match(migration, /question_time_seconds is null or question_time_seconds between 0 and 604800/);
  assert.doesNotMatch(migration, /question_time_seconds[^;]*(not null|default)/i);
  assert.doesNotMatch(migration, /update public\.reading_attempt_answers[\s\S]*where question_time_seconds is null/i);
  assert.match(baseSchema, /question_time_seconds integer constraint reading_attempt_answers_question_time_check/);
});

test("new Reading submit persists answer times inside one atomic database wrapper", () => {
  const callScoring = migration.indexOf("v_result := public.submit_reading_attempt(");
  const alreadySubmittedReturn = migration.indexOf("if coalesce((v_result ->> 'alreadySubmitted')::boolean, false)");
  const updateTimes = migration.indexOf("update public.reading_attempt_answers answer");
  const mismatchGuard = migration.indexOf("READING_QUESTION_TIME_PERSISTENCE_MISMATCH");
  assert.ok(callScoring > 0 && alreadySubmittedReturn > callScoring);
  assert.ok(updateTimes > alreadySubmittedReturn && mismatchGuard > updateTimes);
  assert.doesNotMatch(migration, /\bcommit\b|\brollback\b/i);
  assert.match(migration, /get diagnostics v_updated = row_count/);
  assert.match(migration, /answer\.slot_id is not distinct from submitted\.slot_id/);
  assert.match(migration, /revoke all on function public\.submit_reading_attempt\(uuid, text, integer, jsonb\)[\s\S]*authenticated/);
});

test("client and submit route carry validated per-question seconds to the timed RPC", () => {
  assert.match(practiceUi, /buildReadingSubmissionAnswers\(practice, answers, questionTimes\)/);
  assert.match(submitRoute, /questionTimeSeconds/);
  assert.match(submitRoute, /Number\.isInteger\(questionTimeSeconds\)/);
  assert.match(submitRoute, /rpc\("submit_reading_attempt_with_times"/);
  assert.doesNotMatch(submitRoute, /\.from\("reading_attempt_answers"\)|\.insert\(|\.update\(/);
});

test("result time is loaded from the answer row and browser storage is not authoritative", () => {
  assert.match(resultRoute, /student_answer,is_correct,question_time_seconds/);
  assert.doesNotMatch(resultUi, /mergeStoredReadingQuestionTimes/);
  assert.doesNotMatch(resultSession, /mergeStoredReadingQuestionTimes/);
  assert.match(resultSession, /storeReadingQuestionTimes/);
  assert.match(resultUi, /if \(seconds === null\) return "时间暂无记录"/);
});

test("result mapper preserves DB question time and keeps legacy null", () => {
  const baseInput = {
    attempt: {
      attempt_id: "attempt-1",
      logical_item_id: "RDL-001",
      task_type: "rdl",
      elapsed_seconds: 19,
      submitted_at: "2026-08-29T00:00:00.000Z",
      total_points: 1,
      correct_points: 1
    },
    item: { logical_item_id: "RDL-001", module: "rdl", title: "Daily life" },
    questions: [{ question_id: "q1", question_order: 1, question_type: "rdl" }]
  };
  const persisted = buildReadingResultPayload({
    ...baseInput,
    answers: [{
      attempt_answer_id: "a1",
      question_id: "q1",
      slot_id: null,
      answer_kind: "option",
      student_answer: "o1",
      is_correct: true,
      question_time_seconds: 19
    }]
  });
  const legacy = buildReadingResultPayload({
    ...baseInput,
    answers: [{
      attempt_answer_id: "a2",
      question_id: "q1",
      slot_id: null,
      answer_kind: "option",
      student_answer: "o1",
      is_correct: true,
      question_time_seconds: null
    }]
  });
  assert.equal(persisted.answers[0].questionTimeSeconds, 19);
  assert.equal(legacy.answers[0].questionTimeSeconds, null);
});
