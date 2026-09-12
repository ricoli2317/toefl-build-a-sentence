const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  calculateReadingFullSetScoreRange,
  readingRawToScaled
} = require("../lib/reading/fullSetResults.ts");
const {
  aggregateCtwInteractionTime,
  buildReadingFullSetReviewItems,
  findReadingFullSetReviewIndex,
  readingFullSetReviewItemLabel,
  readingFullSetReviewTotalTime
} = require("../lib/reading/fullSetReview.ts");
const {
  buildReadingFullSetCatalogStates,
  buildReadingFullSets
} = require("../lib/reading/fullSets.ts");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function occurrence(id, taskType, sourceModule, sourceOrder, start, points) {
  return {
    occurrenceId: id,
    logicalItemId: `item-${id}`,
    taskType,
    occurrenceDate: "2026-06-01",
    sourceLabel: "6.1A",
    sourceModule,
    sourceOrder,
    sourceQuestionStart: start,
    sourceQuestionEnd: start + points - 1,
    scoringPointCount: points
  };
}

function fullSet(pattern) {
  const m1 = pattern === "pattern_1"
    ? [
        occurrence("m1-ctw-a", "ctw", "m1", 1, 1, 10),
        occurrence("m1-rdl-s", "rdl", "m1", 2, 11, 2),
        occurrence("m1-rdl-l", "rdl", "m1", 3, 13, 3),
        occurrence("m1-rap-a", "rap", "m1", 4, 16, 5),
        occurrence("m1-ctw-b", "ctw", "m1", 5, 21, 10),
        occurrence("m1-rap-b", "rap", "m1", 6, 31, 5)
      ]
    : [
        occurrence("m1-ctw-a", "ctw", "m1", 1, 1, 10),
        occurrence("m1-rdl-s-a", "rdl", "m1", 2, 11, 2),
        occurrence("m1-rdl-l-a", "rdl", "m1", 3, 13, 3),
        occurrence("m1-rdl-s-b", "rdl", "m1", 4, 16, 2),
        occurrence("m1-rdl-l-b", "rdl", "m1", 5, 18, 3),
        occurrence("m1-rap", "rap", "m1", 6, 21, 5),
        occurrence("m1-ctw-b", "ctw", "m1", 7, 26, 10)
      ];
  return buildReadingFullSets([
    ...m1,
    occurrence("m2-ctw", "ctw", "m2", 1, 1, 10),
    occurrence("m2-rap", "rap", "m2", 2, 11, 5)
  ])[0];
}

function scores(values) {
  return Object.entries(values).map(([occurrenceId, correctPoints]) => ({ occurrenceId, correctPoints }));
}

test("35-point raw lookup maps every requested boundary", () => {
  for (const [raw, scaled] of [[35, 6], [34, 6], [33, 5.5], [27, 4.5], [24, 4], [17, 3.5], [11, 3], [7, 2.5], [6, 2], [5, 1], [0, 1]]) {
    assert.equal(readingRawToScaled(raw), scaled);
  }
  assert.throws(() => readingRawToScaled(36), /OUT_OF_RANGE/);
});

test("Pattern 1 takes one CTW, the single RDL group, one RAP, and all M2", () => {
  const result = calculateReadingFullSetScoreRange(fullSet("pattern_1"), scores({
    "m1-ctw-a": 4, "m1-ctw-b": 8,
    "m1-rdl-s": 1, "m1-rdl-l": 2,
    "m1-rap-a": 2, "m1-rap-b": 5,
    "m2-ctw": 7, "m2-rap": 3
  }));
  assert.deepEqual([result.rawMin, result.rawMax], [19, 26]);
  assert.deepEqual([result.scaledMin, result.scaledMax, result.display], [4, 4.5, "4 - 4.5"]);
  assert.equal(result.breakdown.rdlGrouping, "single_group");
});

test("Pattern 2 uses all legal unpaired short + long RDL combinations", () => {
  const result = calculateReadingFullSetScoreRange(fullSet("pattern_2"), scores({
    "m1-ctw-a": 2, "m1-ctw-b": 9,
    "m1-rdl-s-a": 0, "m1-rdl-s-b": 2,
    "m1-rdl-l-a": 1, "m1-rdl-l-b": 3,
    "m1-rap": 4,
    "m2-ctw": 8, "m2-rap": 4
  }));
  assert.deepEqual([result.breakdown.rdlMin, result.breakdown.rdlMax], [1, 5]);
  assert.deepEqual([result.rawMin, result.rawMax], [19, 30]);
  assert.deepEqual([result.scaledMin, result.scaledMax], [4, 5]);
  assert.equal(result.breakdown.rdlGrouping, "unpaired_legal_combinations");
});

test("equal uncertain groups collapse to a single scaled score and extremes stay within 0–35", () => {
  const equal = calculateReadingFullSetScoreRange(fullSet("pattern_1"), scores({
    "m1-ctw-a": 5, "m1-ctw-b": 5, "m1-rdl-s": 1, "m1-rdl-l": 2,
    "m1-rap-a": 3, "m1-rap-b": 3, "m2-ctw": 5, "m2-rap": 2
  }));
  assert.equal(equal.rawMin, equal.rawMax);
  assert.equal(equal.display, "4");
  const lowest = calculateReadingFullSetScoreRange(fullSet("pattern_1"), scores(Object.fromEntries(
    [...fullSet("pattern_1").module1.occurrences, ...fullSet("pattern_1").module2.occurrences].map((item) => [item.occurrenceId, 0])
  )));
  assert.deepEqual([lowest.rawMin, lowest.rawMax, lowest.scaledMin, lowest.scaledMax], [0, 0, 1, 1]);
});

test("catalog status prioritizes active and picks latest completed with a stable id tie-break", () => {
  const states = buildReadingFullSetCatalogStates([
    { attempt_id: "a", full_set_id: "20260601A", status: "completed", completed_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z" },
    { attempt_id: "b", full_set_id: "20260601A", status: "completed", completed_at: "2026-09-02T00:00:00Z", created_at: "2026-09-02T00:00:00Z" },
    { attempt_id: "c", full_set_id: "20260601A", status: "in_progress", completed_at: null, created_at: "2026-09-03T00:00:00Z" }
  ]);
  assert.deepEqual(states.get("20260601A"), {
    activeAttemptId: "c",
    latestCompletedAttemptId: "b",
    hasCompleted: true,
    status: "in_progress"
  });
  assert.equal(buildReadingFullSetCatalogStates([]).size, 0);
});

test("Full Set result UI is attempt-specific, grouped, scaled-only, timed, readonly, and retake-enabled", () => {
  const resultUi = read("components/reading/ReadingFullSetResult.tsx");
  const navigatorUi = read("components/reading/ReadingFullSetQuestionNavigator.tsx");
  const sharedSummary = read("components/PracticeResult.tsx");
  const resultRoute = read("app/api/reading/full-sets/[fullSetId]/results/[attemptId]/route.ts");
  const reviewRoute = read("app/api/reading/full-sets/[fullSetId]/results/[attemptId]/review/route.ts");
  const practice = read("components/reading/ReadingPractice.tsx");
  assert.match(resultUi, /<PracticeResultSummary/);
  assert.match(resultUi, /scoreValue=\{result\.score\.display\}/);
  assert.match(sharedSummary, /label="得分"/);
  assert.match(sharedSummary, /label="正确率"/);
  assert.match(sharedSummary, /label="用时"/);
  assert.match(sharedSummary, /scoreValue \?\? `\$\{correctPoints\}\/\$\{totalPoints\}`/);
  assert.doesNotMatch(resultUi, /\/ 50|\/50|CEFR/);
  assert.match(resultUi, /buildReadingFullSetReviewItems/);
  assert.match(resultUi, /ReadingFullSetQuestionNavigator/);
  assert.match(resultUi, /scoreComparison=\{null\}/);
  assert.match(resultUi, /timeComparison=\{null\}/);
  assert.doesNotMatch(resultUi, /section\.taskName|formatQuestionTime|ctwTimeByOccurrence/);
  assert.match(navigatorUi, /Module \{moduleNumber\}/);
  assert.match(navigatorUi, /data-answer-state=\{state\}/);
  assert.match(navigatorUi, /第\{readingFullSetReviewItemLabel\(current\)\}题 · \{currentState\} · 耗时:/);
  assert.match(resultRoute, /loadOwnedReadingFullSetAttempt/);
  assert.match(resultRoute, /owned\.attempt\.fullSetId !== params\.fullSetId/);
  assert.match(resultRoute, /status !== "completed"/);
  assert.doesNotMatch(reviewRoute, /searchParams|get\("questionIndex"\)/);
  assert.match(reviewRoute, /buildReadingFullSetReviewItems/);
  assert.match(reviewRoute, /Promise\.all\(occurrenceMetadata\.map/);
  assert.match(practice, /data-testid="reading-review-status"/);
  assert.match(practice, /data-current-slot/);
  assert.doesNotMatch(practice, />只读</);
});

function reviewAnswer({
  index,
  moduleNumber,
  occurrenceId,
  order,
  taskType,
  time = 7
}) {
  return {
    answerId: `answer-${index}`,
    index,
    moduleNumber,
    taskType,
    occurrenceId,
    logicalItemId: `item-${occurrenceId}`,
    order,
    questionId: taskType === "ctw" ? `question-${occurrenceId}` : `question-${index}`,
    slotId: taskType === "ctw" ? `slot-${index}` : null,
    isAnswered: true,
    isCorrect: true,
    questionTimeSeconds: time
  };
}

function fullSetReviewAnswers() {
  const rows = [];
  let index = 0;
  const add = (moduleNumber, occurrenceId, taskType, start, count, time = 7) => {
    for (let offset = 0; offset < count; offset += 1) {
      rows.push(reviewAnswer({
        index: index++, moduleNumber, occurrenceId, order: start + offset, taskType, time
      }));
    }
  };
  add(1, "m1-ctw-a", "ctw", 1, 10, 41);
  add(1, "m1-rdl", "rdl", 11, 10);
  add(1, "m1-ctw-b", "ctw", 21, 10, 53);
  add(1, "m1-rap", "rap", 31, 5);
  add(2, "m2-ctw", "ctw", 1, 10, 37);
  add(2, "m2-rap", "rap", 11, 5);
  return rows;
}

test("Full Set review navigation has two Module rows and one item per CTW slot", () => {
  const items = buildReadingFullSetReviewItems(fullSetReviewAnswers(), (index) => `/questions/${index}`);
  assert.equal(items.length, 50);
  assert.deepEqual(
    items.filter((item) => item.moduleNumber === 1).map(readingFullSetReviewItemLabel),
    Array.from({ length: 35 }, (_, index) => String(index + 1))
  );
  assert.deepEqual(
    items.filter((item) => item.moduleNumber === 2).map(readingFullSetReviewItemLabel),
    Array.from({ length: 15 }, (_, index) => String(index + 1))
  );
  assert.equal(items.filter((item) => item.taskType === "ctw").length, 30);
  assert.equal(items[0].slotReviews.length, 10);
  assert.equal(items[10].slotReviews.length, 10);
  assert.equal(findReadingFullSetReviewIndex(items, items[10].slotReviews[4].index), 14);
  assert.deepEqual(
    items.slice(0, 10).map((item) => [item.isAnswered, item.isCorrect, item.sourceAnswerIndex]),
    fullSetReviewAnswers().slice(0, 10).map((answer) => [answer.isAnswered, answer.isCorrect, answer.index])
  );
});

test("CTW review time supports real slot aggregation, legacy interaction timing, and missing history", () => {
  const complete = fullSetReviewAnswers();
  const ctw = complete.filter((answer) => answer.occurrenceId === "m1-ctw-a");
  assert.equal(aggregateCtwInteractionTime(ctw), 41);
  assert.equal(readingFullSetReviewTotalTime(complete), 271);
  ctw.forEach((answer, index) => { answer.questionTimeSeconds = index + 1; });
  assert.equal(aggregateCtwInteractionTime(ctw), 55);
  const ctwItems = buildReadingFullSetReviewItems(complete, () => "")
    .filter((item) => item.occurrenceId === "m1-ctw-a");
  assert.deepEqual(ctwItems.map((item) => item.questionTimeSeconds), Array(10).fill(55));
  ctw[4].questionTimeSeconds = null;
  assert.equal(aggregateCtwInteractionTime(ctw), null);
  assert.equal(readingFullSetReviewTotalTime(complete), null);
});

test("Full Set review switches in memory and updates history without route navigation or per-question fetch", () => {
  const practice = read("components/reading/ReadingPractice.tsx");
  const fullSetStart = practice.indexOf("export function ReadingFullSetSubmittedReview");
  const fullSetEnd = practice.indexOf("function ReadingPracticeShell", fullSetStart);
  const fullSetReview = practice.slice(fullSetStart, fullSetEnd);
  assert.match(fullSetReview, /useStudentCachedData<ReadingFullSetReviewPayload>/);
  assert.match(fullSetReview, /window\.history\.pushState/);
  assert.match(fullSetReview, /addEventListener\("popstate"/);
  assert.equal((fullSetReview.match(/fetch\(/g) ?? []).length, 1);
  assert.doesNotMatch(fullSetReview, /router\.push\(target\.href\)|questionIndex=\$\{questionIndex\}/);
  assert.match(fullSetReview, /ReadingFullSetQuestionNavigator/);
  assert.match(fullSetReview, /statusLabel=\{statusLabel\}/);
  assert.match(fullSetReview, /activeSlotReview/);
  assert.match(fullSetReview, /item\.index === currentItem\.sourceAnswerIndex/);
  assert.doesNotMatch(fullSetReview, /key=\{currentItem/);
});

test("Full Set timing hotfix preserves unknown history as NULL and runner records real time", () => {
  const runner = read("components/reading/ReadingFullSetRunner.tsx");
  const migration = read("supabase/reading_full_set_question_time_nullable.sql");
  assert.match(runner, /snapshotQuestionTimes/);
  assert.match(runner, /commitActiveQuestionTime/);
  assert.match(runner, /10_000/);
  assert.doesNotMatch(runner, /pending\.answers,\s*\{\}/);
  assert.match(migration, /set question_time_seconds = null[\s\S]*where question_time_seconds = 0/);
  assert.match(migration, /alter column question_time_seconds drop not null/);
});
