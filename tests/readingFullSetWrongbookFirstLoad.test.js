const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildReadingFullSetWrongbookProgress,
  buildReadingFullSetWrongbookQueue,
  findReadingFullSetFirstWrongbookTarget,
  sameReadingFullSetWrongbookTargets
} = require("../lib/wrongQuestions.ts");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function target(attemptId, index, overrides = {}) {
  const taskType = overrides.taskType ?? (index < 7 ? "ctw" : index < 13 ? "rdl" : "rap");
  const occurrenceId = overrides.occurrenceId ?? `occurrence-${String(index).padStart(2, "0")}`;
  return {
    attemptId,
    isCorrect: false,
    logicalItemId: `reading-${taskType}-${String(index).padStart(24, "0")}`,
    moduleNumber: index < 10 ? 1 : 2,
    occurrenceId,
    order: index + 1,
    questionId: `question-${String(index).padStart(2, "0")}`,
    slotId: taskType === "ctw" ? `slot-${index}` : null,
    taskType,
    ...overrides
  };
}

test("early Full Set target selection is exactly equivalent to the complete queue first target", () => {
  const sourceAttemptId = "11111111-1111-4111-8111-111111111111";
  const otherAttemptId = "22222222-2222-4222-8222-222222222222";
  const correctionA = "correction-a";
  const correctionB = "correction-b";
  const sourceAnswers = Array.from({ length: 18 }, (_, index) => target(sourceAttemptId, index));
  const input = {
    fullSetAnswers: [
      target(otherAttemptId, 0),
      ...sourceAnswers.slice().reverse(),
      target(sourceAttemptId, 30, { isCorrect: true })
    ],
    fullSetAttempts: [
      { attemptId: otherAttemptId, completedAt: "2026-09-12T08:00:00.000Z", fullSetId: "20260912B", title: "20260912B" },
      { attemptId: sourceAttemptId, completedAt: "2026-09-14T08:00:00.000Z", fullSetId: "20260914A", title: "20260914A" }
    ],
    fullSetCorrectionAttempts: [
      { attemptId: correctionB, sourceAttemptId, submittedAt: "2026-09-14T10:00:00.000Z" },
      { attemptId: correctionA, sourceAttemptId, submittedAt: "2026-09-14T09:00:00.000Z" }
    ],
    fullSetCorrectionAnswers: [
      { ...sourceAnswers[0], attemptId: correctionA, isCorrect: true },
      { ...sourceAnswers[1], attemptId: correctionA, isCorrect: true },
      // A later incorrect correction reopens the exact first source identity.
      { ...sourceAnswers[0], attemptId: correctionB, isCorrect: false }
    ],
    scope: "history",
    sourceAttemptId,
    todayEnd: Date.parse("2026-09-15T00:00:00.000Z"),
    todayStart: Date.parse("2026-09-14T00:00:00.000Z")
  };

  for (const answers of [
    input.fullSetAnswers,
    input.fullSetAnswers.slice().reverse(),
    [...input.fullSetAnswers.slice(5), ...input.fullSetAnswers.slice(0, 5)]
  ]) {
    const candidate = { ...input, fullSetAnswers: answers };
    const queue = buildReadingFullSetWrongbookQueue(candidate);
    const first = findReadingFullSetFirstWrongbookTarget(candidate);
    assert.equal(queue.length, 1);
    assert.deepEqual(first, queue[0].targets[0]);
    assert.equal(queue[0].targets.length, 17);
    assert.ok(sameReadingFullSetWrongbookTargets(queue[0].targets, [...queue[0].targets]));
    assert.deepEqual(
      buildReadingFullSetWrongbookProgress(queue[0].targets),
      buildReadingFullSetWrongbookProgress([...queue[0].targets])
    );
  }

  assert.deepEqual(
    findReadingFullSetFirstWrongbookTarget({ ...input, scope: "today" }),
    buildReadingFullSetWrongbookQueue({ ...input, scope: "today" })[0].targets[0]
  );
  assert.equal(
    findReadingFullSetFirstWrongbookTarget({
      ...input,
      scope: "today",
      todayEnd: Date.parse("2026-09-14T00:00:00.000Z"),
      todayStart: Date.parse("2026-09-13T00:00:00.000Z")
    }),
    null
  );
});

test("Full Set bootstrap starts one shared practice load before attempt RPC and returns it atomically", () => {
  const route = read("app/api/reading/wrongbook-attempts/route.ts");
  const queue = read("lib/reading/fullSetWrongbook.server.ts");
  const practiceApi = read("app/api/reading/practice/[itemId]/route.ts");
  const runtime = read("components/reading/ReadingFullSetWrongbookPractice.tsx");

  assert.match(route, /loadReadingFullSetWrongbookBootstrapQueue/);
  assert.match(route, /loadStudentReadingPractice/);
  assert.match(practiceApi, /loadStudentReadingPractice/);
  assert.equal((route.match(/loadStudentReadingPractice\(/g) ?? []).length, 1);
  assert.equal((route.match(/get_or_create_reading_full_set_wrongbook_attempt/g) ?? []).length, 1);
  assert.ok(route.indexOf("Full Set first practice start") < route.indexOf("full_set_get_or_create_attempt"));
  assert.ok(queue.indexOf("input.onFirstTarget(firstTarget)") < queue.indexOf("buildReadingFullSetWrongbookQueue(queueInput)"));
  assert.match(route, /Promise\.all\(\[\s*preservedAnswersPromise,\s*firstPracticePromise\s*\]\)/);
  assert.match(route, /firstPractice: firstPracticeResult\.practice/);
  assert.match(route, /sameReadingFullSetWrongbookTargets\(data\.targets, item\.targets\)/);
  assert.match(route, /p_targets: item\.targets/);
  assert.match(route, /targets: item\.targets/);
  assert.match(route, /首题内容加载失败/);

  assert.match(runtime, /const bootstrapPractice =/);
  assert.match(runtime, /enabled: Boolean\(stepTarget && !bootstrapPractice\)/);
  assert.match(runtime, /const sourcePracticeData = bootstrapPractice \?\? sourcePractice\.data/);
  assert.match(runtime, /buildReadingFullSetWrongbookProgress\(attempt\?\.targets \?\? \[\]\)/);
  assert.match(runtime, /preservedAnswersByOccurrence\?\.\[step\.occurrenceId\]/);
  assert.doesNotMatch(runtime, /\/api\/reading\/practices\?itemIds=/);
});

test("Full Set correction queue reads only wrong answers with embedded canonical ordering", () => {
  const queue = read("lib/reading/fullSetWrongbook.server.ts");

  assert.match(queue, /full_set_source_wrong_answers_ordered/);
  assert.match(queue, /reading_source_occurrences!inner\(source_question_start\)/);
  assert.match(queue, /reading_questions!inner\(question_order,module\)/);
  assert.match(queue, /reading_ctw_slots\(slot_order\)/);
  assert.match(queue, /\.eq\("is_correct", false\)/);
  assert.doesNotMatch(queue, /query: "full_set_question_order"/);
  assert.doesNotMatch(queue, /query: "full_set_slot_order"/);
  assert.doesNotMatch(queue, /query: "full_set_occurrence_order"/);
});

test("Full Set bootstrap instrumentation exposes the overlap and one-request render boundary", () => {
  const route = read("app/api/reading/wrongbook-attempts/route.ts");
  const runtime = read("components/reading/ReadingFullSetWrongbookPractice.tsx");
  const verifier = read("scripts/verify-wrongbook-performance.ts");

  for (const stage of [
    "Full Set bootstrap total",
    "Full Set first target known",
    "Full Set first practice start",
    "Full Set first practice load",
    "Full Set full queue finish",
    "wrongbook attempt creation/reuse"
  ]) assert.match(route, new RegExp(stage));
  assert.match(runtime, /measureStudentRequest\("POST \/api\/reading\/wrongbook-attempts \(Full Set bootstrap\)"/);
  assert.match(runtime, /"X-TPS-Performance-Debug": "1"/);
  assert.match(runtime, /useStudentPagePerformance/);
  assert.match(verifier, /single_bootstrap_with_embedded_first_practice/);
  assert.match(verifier, /practiceOverlappedAttempt/);
  assert.doesNotMatch(verifier, /bootstrap_then_practice_GET/);
});
