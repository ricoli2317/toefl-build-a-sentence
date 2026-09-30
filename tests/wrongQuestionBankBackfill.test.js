const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildWrongQuestionBackfillHistory,
  buildWrongQuestionBackfillPending
} = require("../lib/wrongQuestionBankBackfill.ts");

const projectRoot = path.resolve(__dirname, "..");
const today = "2026-09-30";
const yesterday = "2026-09-29";

function basAnswer({
  finalSentence = null,
  isCorrect,
  kind = "formal",
  questionId,
  date = today,
  time
}) {
  return {
    eventDate: date,
    eventTimeMs: time,
    finalSentence,
    isCorrect,
    kind,
    questionId,
    studentId: "student-1",
    taskType: "bas"
  };
}

function readingAnswer({
  isCorrect,
  kind = "formal",
  logicalItemId = "reading-rdl-item",
  questionId,
  slotId = null,
  date = today,
  taskType = "rdl",
  time
}) {
  return {
    eventDate: date,
    eventTimeMs: time,
    isCorrect,
    kind,
    logicalItemId,
    questionId,
    slotId,
    studentId: "student-1",
    taskType
  };
}

test("history backfill keeps only formal practice wrongs", () => {
  const history = buildWrongQuestionBackfillHistory([
    basAnswer({ finalSentence: "The cat sleeps.", isCorrect: false, questionId: "bas-q1", time: 1 }),
    basAnswer({ finalSentence: "The dog runs.", isCorrect: true, questionId: "bas-q2", time: 2 }),
    basAnswer({ finalSentence: "The bird sings.", isCorrect: false, kind: "clearing-correction", questionId: "bas-q3", time: 3 }),
    basAnswer({ finalSentence: "The fish swims.", isCorrect: false, kind: "non-clearing-correction", questionId: "bas-q4", time: 4 }),
    readingAnswer({ isCorrect: false, questionId: "rdl-q1", time: 5 }),
    readingAnswer({ isCorrect: true, kind: "clearing-correction", questionId: "rdl-q1", time: 6 })
  ]);

  assert.equal(history.length, 2);
  assert.deepEqual(
    history.map((identity) => [identity.taskType, identity.key]).sort(),
    [["bas", "sentence:The cat sleeps."], ["rdl", "reading-rdl-item:rdl-q1:question"]]
  );
});

test("repeated wrongs collapse into one identity and keep first/last wrong times", () => {
  const history = buildWrongQuestionBackfillHistory([
    basAnswer({ finalSentence: "One logical sentence.", isCorrect: false, questionId: "bas-q1", time: 10 }),
    basAnswer({ finalSentence: "One logical sentence.", isCorrect: false, questionId: "bas-q1", time: 30 }),
    basAnswer({ finalSentence: "One logical sentence.", isCorrect: false, questionId: "bas-q1", time: 20 })
  ]);

  assert.equal(history.length, 1);
  assert.equal(history[0].key, "sentence:One logical sentence.");
  assert.equal(history[0].firstWrongAtMs, 10);
  assert.equal(history[0].lastWrongAtMs, 30);
});

test("different question_ids of one logical BAS question share one identity", () => {
  const history = buildWrongQuestionBackfillHistory([
    basAnswer({ finalSentence: "Same logical question.", isCorrect: false, questionId: "bas-source-a-q7", time: 100 }),
    basAnswer({ finalSentence: "Same logical question.", isCorrect: false, questionId: "bas-source-b-q3", time: 200 }),
    basAnswer({ finalSentence: "A truly different question.", isCorrect: false, questionId: "bas-source-a-q8", time: 300 })
  ]);

  assert.equal(history.length, 2);
  const merged = history.find((identity) => identity.key === "sentence:Same logical question.");
  assert.ok(merged);
  assert.equal(merged.firstWrongAtMs, 100);
  assert.equal(merged.lastWrongAtMs, 200);
  assert.ok(history.some((identity) => identity.key === "sentence:A truly different question."));
});

test("BAS questions without a final sentence fall back to the question id key", () => {
  const history = buildWrongQuestionBackfillHistory([
    basAnswer({ isCorrect: false, questionId: "bas-empty-1", time: 1 }),
    basAnswer({ isCorrect: false, questionId: "bas-empty-2", time: 2 })
  ]);

  assert.deepEqual(
    history.map((identity) => identity.key).sort(),
    ["question:bas-empty-1", "question:bas-empty-2"]
  );
});

test("Full Set wrongs merge with the ordinary Reading identity", () => {
  const history = buildWrongQuestionBackfillHistory([
    readingAnswer({ isCorrect: false, questionId: "rdl-q1", time: 100 }),
    readingAnswer({ isCorrect: false, questionId: "rdl-q1", time: 200 })
  ]);

  assert.equal(history.length, 1);
  assert.equal(history[0].firstWrongAtMs, 100);
  assert.equal(history[0].lastWrongAtMs, 200);
});

test("today pending: wrong -> pending, repeated wrong -> one, correction -> cleared", () => {
  const answers = [
    basAnswer({ finalSentence: "Q one.", isCorrect: false, questionId: "bas-q1", time: 1 }),
    basAnswer({ finalSentence: "Q one.", isCorrect: false, questionId: "bas-q1", time: 2 }),
    basAnswer({ finalSentence: "Q two.", isCorrect: false, questionId: "bas-q2", time: 3 }),
    basAnswer({ finalSentence: "Q two.", isCorrect: true, kind: "clearing-correction", questionId: "bas-q2", time: 4 }),
    basAnswer({ finalSentence: "Q three.", isCorrect: false, questionId: "bas-q3", time: 5 }),
    basAnswer({ finalSentence: "Q three.", isCorrect: false, kind: "clearing-correction", questionId: "bas-q3", time: 6 })
  ];
  const pending = buildWrongQuestionBackfillPending({ answers, practiceDate: today });

  assert.deepEqual(
    pending.map((entry) => entry.key).sort(),
    ["sentence:Q one.", "sentence:Q three."]
  );
  assert.equal(pending.filter((entry) => entry.key === "sentence:Q one.").length, 1);
  assert.ok(pending.every((entry) => entry.pendingDate === today));
});

test("today pending: correct then wrong again re-enters the same day", () => {
  const answers = [
    basAnswer({ finalSentence: "Re-entry.", isCorrect: false, questionId: "bas-q1", time: 1 }),
    basAnswer({ finalSentence: "Re-entry.", isCorrect: true, kind: "clearing-correction", questionId: "bas-q1", time: 2 }),
    basAnswer({ finalSentence: "Re-entry.", isCorrect: false, questionId: "bas-q1", time: 3 })
  ];
  const pending = buildWrongQuestionBackfillPending({ answers, practiceDate: today });

  assert.deepEqual(pending.map((entry) => [entry.key, entry.pendingDate]), [
    ["sentence:Re-entry.", today]
  ]);
});

test("yesterday's uncorrected wrongs never appear in today's pending", () => {
  const answers = [
    basAnswer({ finalSentence: "Old wrong.", isCorrect: false, questionId: "bas-old", date: yesterday, time: 1 }),
    readingAnswer({ isCorrect: false, questionId: "rdl-old", date: yesterday, time: 2 }),
    basAnswer({ finalSentence: "Today wrong.", isCorrect: false, questionId: "bas-today", time: 3 })
  ];
  const pending = buildWrongQuestionBackfillPending({ answers, practiceDate: today });

  assert.deepEqual(pending.map((entry) => entry.key), ["sentence:Today wrong."]);
});

test("history practice wrongs and history entry corrections never change today's pending", () => {
  const answers = [
    basAnswer({ finalSentence: "Kept.", isCorrect: false, questionId: "bas-kept", time: 1 }),
    basAnswer({ finalSentence: "Kept.", isCorrect: true, kind: "non-clearing-correction", questionId: "bas-kept", time: 2 }),
    readingAnswer({ isCorrect: false, questionId: "rdl-kept", time: 3 }),
    readingAnswer({ isCorrect: true, kind: "non-clearing-correction", questionId: "rdl-kept", time: 4 }),
    readingAnswer({ isCorrect: false, kind: "non-clearing-correction", questionId: "rdl-extra", time: 5 })
  ];
  const pending = buildWrongQuestionBackfillPending({ answers, practiceDate: today });

  assert.deepEqual(
    pending.map((entry) => entry.key).sort(),
    ["reading-rdl-item:rdl-kept:question", "sentence:Kept."]
  );
});

test("Full Set formal wrongs restore the day's Reading pending for their module", () => {
  const answers = [
    readingAnswer({ isCorrect: false, questionId: "ctw-q1", slotId: "slot-1", taskType: "ctw", time: 1 }),
    readingAnswer({ isCorrect: false, questionId: "rap-q1", taskType: "rap", time: 2 })
  ];
  const pending = buildWrongQuestionBackfillPending({ answers, practiceDate: today });

  assert.deepEqual(
    pending.map((entry) => [entry.taskType, entry.key, entry.pendingDate]).sort(),
    [
      ["ctw", "reading-rdl-item:ctw-q1:slot-1", today],
      ["rap", "reading-rdl-item:rap-q1:question", today]
    ]
  );
});

test("backfill SQL only restores the target business day and reuses the shared BAS key", () => {
  const sql = fs.readFileSync(
    path.join(projectRoot, "supabase/student_wrong_questions_backfill.sql"),
    "utf8"
  );

  // Formal-only history sources.
  assert.match(sql, /from public\.attempt_answers aa/);
  assert.match(sql, /from public\.reading_attempt_answers aa/);
  assert.match(sql, /from public\.reading_full_set_answers fsa/);
  assert.match(sql, /fa\.status = 'completed'/);
  // Reading answer rows carry no student_id: the student always comes from the
  // owning attempt row.
  assert.match(sql, /ra\.student_id,\n    ra\.task_type,/);
  assert.match(sql, /ra\.student_id,\n      ra\.task_type,\n      ra\.logical_item_id \|\|/);
  assert.doesNotMatch(sql, /reading_attempt_answers aa[\s\S]{0,200}aa\.student_id/);
  // Block-level audit: no block that reads reading_attempt_answers may touch a
  // column that table does not have.
  for (const block of sql.split(/\n\n+/)) {
    if (!block.includes("public.reading_attempt_answers aa")) continue;
    assert.doesNotMatch(block, /aa\.student_id/, "reading_attempt_answers has no student_id");
    assert.doesNotMatch(block, /aa\.set_id/, "reading_attempt_answers has no set_id");
    assert.doesNotMatch(block, /aa\.answered_at/, "reading_attempt_answers has no answered_at");
  }
  // Virtual BAS sets and grammar never create history/pending.
  assert.match(sql, /lower\(btrim\(coalesce\(a\.set_id, ''\)\)\) !~ '\^\(wrongbook\|grammar\)-'/);
  // Shared BAS content key (identical to the live submit hook).
  assert.match(sql, /'sentence:' \|\| btrim\(regexp_replace\(coalesce\(q\.final_sentence, ''\), '\\s\+', ' ', 'g'\)\)/);
  assert.match(sql, /'question:' \|\| btrim\(aa\.question_id\)/);
  // Only today-scope ordinary corrections clear; Full Set corrections clear.
  assert.match(sql, /wa\.scope = 'today'/);
  assert.match(sql, /wa\.task_type = 'full_set'/);
  assert.match(sql, /like 'wrongbook-today-%'/);
  // Daily pending: the winning event's business date must be the target date.
  assert.match(sql, /\(event_time at time zone 'Asia\/Shanghai'\)::date as event_date/);
  assert.match(sql, /and event_date = p_practice_date/);
  assert.match(sql, /p_practice_date date default \(now\(\) at time zone 'Asia\/Shanghai'\)::date/);
  // Re-runnable: conflicts widen times only, pending touches untouched rows only.
  assert.match(sql, /on conflict \(student_id, task_type, question_key\) do update/);
  assert.match(sql, /target\.updated_at = target\.created_at/);
  assert.match(sql, /grant execute on function public\.backfill_student_wrong_questions\(date\) to service_role/);
  // Never modifies historical attempts or answers.
  assert.doesNotMatch(sql, /update public\.attempts|update public\.attempt_answers|update public\.reading_attempts|update public\.reading_attempt_answers|update public\.reading_full_set/);
});
