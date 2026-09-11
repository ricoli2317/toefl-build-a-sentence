const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { buildWrongQuestionsOverview } = require("../lib/wrongQuestions.ts");

const projectRoot = path.resolve(__dirname, "..");

function basAttempt(attemptId, submittedAt) {
  return {
    attemptId,
    setId: "bas-source-112",
    setTitle: "legacy title",
    correctCount: 0,
    totalQuestions: 2,
    timeSpentSeconds: 120,
    submittedAt
  };
}

function basAnswer({
  answerId,
  attemptId,
  finalSentence,
  grammarTag,
  isCorrect,
  questionId,
  time
}) {
  return {
    attemptAnswerId: answerId,
    attemptId,
    questionId,
    questionOrder: 1,
    prompt: "",
    sentenceTemplate: "",
    optionsText: "",
    finalSentence,
    grammarTag,
    submittedOrderText: "",
    isCorrect,
    questionTimeSeconds: null,
    answeredAt: time
  };
}

test("wrong-question overview reuses BAS dedupe/correction and aggregates all four objective task types", () => {
  const todayStart = Date.parse("2026-08-30T00:00:00.000Z");
  const todayEnd = Date.parse("2026-08-31T00:00:00.000Z");
  const payload = buildWrongQuestionsOverview({
    basAttempts: [
      basAttempt("bas-old", "2026-08-28T08:00:00.000Z"),
      basAttempt("bas-duplicate", "2026-08-29T08:00:00.000Z"),
      basAttempt("bas-today", "2026-08-30T08:00:00.000Z")
    ],
    basAnswers: [
      basAnswer({
        answerId: "a1",
        attemptId: "bas-old",
        finalSentence: "The sentence is shared.",
        grammarTag: "从句",
        isCorrect: false,
        questionId: "bas-q-old",
        time: "2026-08-28T08:00:00.000Z"
      }),
      basAnswer({
        answerId: "a2",
        attemptId: "bas-duplicate",
        finalSentence: "  The sentence is shared.  ",
        grammarTag: "从句",
        isCorrect: false,
        questionId: "bas-q-copy",
        time: "2026-08-29T08:00:00.000Z"
      }),
      basAnswer({
        answerId: "a3",
        attemptId: "bas-today",
        finalSentence: "A different sentence.",
        grammarTag: "时态",
        isCorrect: false,
        questionId: "bas-q-today",
        time: "2026-08-30T08:00:00.000Z"
      })
    ],
    basCorrectionAnswers: [
      basAnswer({
        answerId: "correction-1",
        attemptId: "wrongbook-all",
        finalSentence: "The sentence is shared.",
        grammarTag: "从句",
        isCorrect: true,
        questionId: "bas-q-old",
        time: "2026-08-29T09:00:00.000Z"
      })
    ],
    basGroupsBySet: new Map([["bas-source-112", { groupId: "logical-bas-112", title: "套题112" }]]),
    readingAttempts: [
      { attemptId: "ctw-old", logicalItemId: "ctw-096", submittedAt: "2026-08-28T10:00:00.000Z", taskType: "ctw" },
      { attemptId: "ctw-new", logicalItemId: "ctw-096", submittedAt: "2026-08-29T10:00:00.000Z", taskType: "ctw" },
      { attemptId: "rdl-old", logicalItemId: "rdl-music", submittedAt: "2026-08-28T11:00:00.000Z", taskType: "rdl" },
      { attemptId: "rdl-new", logicalItemId: "rdl-music", submittedAt: "2026-08-29T11:00:00.000Z", taskType: "rdl" },
      { attemptId: "rap-today", logicalItemId: "rap-stars", submittedAt: "2026-08-30T12:00:00.000Z", taskType: "rap" }
    ],
    // Intentionally not chronological: the builder must use submitted time, not query order.
    readingAnswers: [
      { attemptId: "ctw-new", isCorrect: true, questionId: "ctw-q", slotId: "slot-1" },
      { attemptId: "rdl-new", isCorrect: true, questionId: "rdl-q", slotId: null },
      { attemptId: "ctw-old", isCorrect: false, questionId: "ctw-q", slotId: "slot-1" },
      { attemptId: "ctw-old", isCorrect: false, questionId: "ctw-q", slotId: "slot-2" },
      { attemptId: "ctw-new", isCorrect: false, questionId: "ctw-q", slotId: "slot-2" },
      { attemptId: "rdl-old", isCorrect: false, questionId: "rdl-q", slotId: null },
      { attemptId: "rap-today", isCorrect: false, questionId: "rap-q", slotId: null }
    ],
    readingTitles: new Map([
      ["ctw-096", "套题096"],
      ["rdl-music", "Bridgeford University Music & Culture Night"],
      ["rap-stars", "Optical Astronomy's Adaptive Revolution"]
    ]),
    todayStart,
    todayEnd
  });

  assert.deepEqual(payload.stats, { corrected: 3, pending: 3, todayNew: 2, total: 6 });
  assert.equal(payload.groups.length, 4);
  assert.deepEqual(
    payload.groups.map((group) => [group.taskType, group.wrongCount, group.correctedCount, group.pendingCount]).sort(),
    [
      ["build_sentence", 2, 1, 1],
      ["ctw", 2, 1, 1],
      ["rap", 1, 0, 1],
      ["rdl", 1, 1, 0]
    ]
  );
  assert.equal(payload.groups.find((group) => group.taskType === "build_sentence").title, "套题112");
  assert.deepEqual(payload.grammarPoints, [
    { tag: "从句", count: 1 },
    { tag: "时态", count: 1 }
  ]);
});

test("wrong-question home keeps BAS analysis behind the BAS tab and exposes only requested labels", () => {
  const ui = fs.readFileSync(path.join(projectRoot, "components/WrongQuestionsHome.tsx"), "utf8");
  const route = fs.readFileSync(path.join(projectRoot, "app/api/wrong-questions/route.ts"), "utf8");

  assert.match(ui, /activeTab === "build_sentence"[\s\S]*<BasGrammarAnalysis/);
  assert.match(ui, /useState<WrongQuestionTaskType \| "all">\("all"\)/);
  assert.match(ui, /CompleteTheWordsIcon/);
  for (const label of ["待订正", "已订正", "本日新增", "总错题"]) assert.match(ui, new RegExp(label));
  assert.doesNotMatch(ui, /待复习|近7天|复习完成/);
  assert.match(route, /\.from\("attempts"\)/);
  assert.match(route, /\.from\("attempt_answers"\)/);
  assert.match(route, /\.from\("reading_attempts"\)/);
  assert.match(route, /"reading_attempt_answers"/);
  assert.match(route, /"reading_logical_items"/);
});
