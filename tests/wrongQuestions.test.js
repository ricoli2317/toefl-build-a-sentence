const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildBasWrongbookEntryQuestionIds,
  buildBasWrongbookPracticeQuestionIds,
  buildReadingFullSetWrongbookProgress,
  buildReadingFullSetWrongbookQueue,
  buildReadingWrongbookQueue,
  buildWrongQuestionsOverview,
  readingFullSetWrongbookProgressLabel
} = require("../lib/wrongQuestions.ts");
const {
  buildReadingWrongbookInitialAnswers
} = require("../lib/reading/wrongbook.ts");
const {
  buildReadingCorrectionResultAnswers,
  readingCorrectionMarkState
} = require("../lib/reading/correctionResult.ts");
const {
  compareReadingCatalogIdentityOrder,
  readingCatalogDisplayNumbers
} = require("../lib/reading/catalog.ts");

const projectRoot = path.resolve(__dirname, "..");

function basAttempt(attemptId, submittedAt, setId = "bas-source-112") {
  return {
    attemptId,
    setId,
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
  assert.equal(
    payload.groups.find((group) => group.taskType === "build_sentence").correctionHref,
    "/student/wrong-questions/history/practice?scope=entry&groupId=logical-bas-112"
  );
  assert.equal(payload.groups.find((group) => group.taskType === "rdl").correctionHref, null);
  assert.match(
    payload.groups.find((group) => group.taskType === "ctw").correctionHref,
    /^\/student\/wrong-questions\/history\/reading\/practice\?/
  );
  assert.match(
    payload.groups.find((group) => group.taskType === "rap").correctionHref,
    /^\/student\/wrong-questions\/today\/reading\/practice\?/
  );
  assert.deepEqual(payload.grammarPoints, [
    { tag: "从句", count: 1 },
    { tag: "时态", count: 1 }
  ]);
});

test("wrong-question home keeps BAS analysis behind the BAS tab and exposes only requested labels", () => {
  const ui = fs.readFileSync(path.join(projectRoot, "components/WrongQuestionsHome.tsx"), "utf8");
  const route = fs.readFileSync(path.join(projectRoot, "app/api/wrong-questions/route.ts"), "utf8");

  assert.match(ui, /activeTab === "build_sentence"[\s\S]*<BasGrammarAnalysis/);
  assert.match(ui, /activeTab === "build_sentence"[\s\S]*<BasCorrectionActions \/>[\s\S]*<BasGrammarAnalysis/);
  assert.match(ui, /今日错题订正/);
  assert.match(ui, /历史错题订正/);
  assert.match(ui, /group\.pendingCount > 0 && group\.correctionHref/);
  assert.match(ui, /const groups = state\.data\?\.groups\.filter/);
  assert.match(ui, /<WrongQuestionGroupList groups=\{groups\} \/>/);
  assert.match(ui, /ReadingCorrectionActions taskType=\{activeTab\}/);
  assert.match(ui, /readingCorrectionHref\("today", taskType\)/);
  assert.match(ui, /readingCorrectionHref\("history", taskType\)/);
  assert.match(ui, /去订正/);
  assert.match(ui, /查看错题/);
  assert.match(ui, /useState<WrongQuestionTaskType \| "all">\("all"\)/);
  assert.match(ui, /CompleteTheWordsIcon/);
  for (const label of ["待订正", "已订正", "本日新增", "总错题"]) assert.match(ui, new RegExp(label));
  assert.doesNotMatch(ui, /待复习|近7天|复习完成/);
  assert.match(route, /\.from\("attempts"\)/);
  assert.match(route, /\.from\("attempt_answers"\)/);
  assert.match(route, /loadReadingWrongbookData\(db, studentId\)/);
  assert.match(route, /loadReadingFullSetWrongbookOverviewData\(db, studentId\)/);
  assert.match(route, /\.eq\("is_correct", false\)/);
  assert.match(route, /"question_id,set_id,question_order,final_sentence,grammar_tags_text"/);
  assert.doesNotMatch(route, /searchParams\.get\("questionId"\)/);
  assert.doesNotMatch(route, /selectedIds = selectedIds\.filter\(\(questionId\) => questionId === requestedQuestionId\)/);
});

test("corrected Reading cards reopen the exact historical correction result", () => {
  const ordinaryCorrectionId = "11111111-1111-4111-8111-111111111111";
  const fullSetCorrectionId = "22222222-2222-4222-8222-222222222222";
  const sourceFullSetAttemptId = "33333333-3333-4333-8333-333333333333";
  const payload = buildWrongQuestionsOverview({
    basAnswers: [],
    basAttempts: [],
    basCorrectionAnswers: [],
    basGroupsBySet: new Map(),
    readingAnswers: [{ attemptId: "ordinary-rdl", isCorrect: false, questionId: "rdl-q", slotId: null }],
    readingAttempts: [{
      attemptId: "ordinary-rdl",
      logicalItemId: "rdl-item",
      submittedAt: "2026-08-28T08:00:00.000Z",
      taskType: "rdl"
    }],
    readingCorrectionAnswers: [{
      attemptId: ordinaryCorrectionId,
      isCorrect: true,
      questionId: "rdl-q",
      slotId: null
    }],
    readingCorrectionAttempts: [{
      attemptId: ordinaryCorrectionId,
      logicalItemId: "rdl-item",
      scope: "history",
      submittedAt: "2026-08-29T08:00:00.000Z",
      taskType: "rdl"
    }],
    readingTitles: new Map([["rdl-item", "RDL item"]]),
    fullSetAnswers: [{
      attemptId: sourceFullSetAttemptId,
      isCorrect: false,
      logicalItemId: "rap-item",
      moduleNumber: 1,
      occurrenceId: "occurrence-1",
      order: 31,
      questionId: "rap-q",
      slotId: null,
      taskType: "rap"
    }],
    fullSetAttempts: [{
      attemptId: sourceFullSetAttemptId,
      completedAt: "2026-08-28T09:00:00.000Z",
      fullSetId: "20260828A",
      title: "20260828A"
    }],
    fullSetCorrectionAnswers: [{
      attemptId: fullSetCorrectionId,
      isCorrect: true,
      logicalItemId: "rap-item",
      moduleNumber: 1,
      occurrenceId: "occurrence-1",
      order: 31,
      questionId: "rap-q",
      slotId: null,
      taskType: "rap"
    }],
    fullSetCorrectionAttempts: [{
      attemptId: fullSetCorrectionId,
      sourceAttemptId: sourceFullSetAttemptId,
      submittedAt: "2026-08-29T09:00:00.000Z"
    }],
    todayStart: Date.parse("2026-08-30T00:00:00.000Z"),
    todayEnd: Date.parse("2026-08-31T00:00:00.000Z")
  });

  assert.equal(
    payload.groups.find((group) => group.taskType === "rdl").actionHref,
    `/student/reading/wrongbook-results/${ordinaryCorrectionId}`
  );
  assert.equal(
    payload.groups.find((group) => group.taskType === "full_set").actionHref,
    `/student/reading/wrongbook-results/${fullSetCorrectionId}`
  );
});

test("Reading canonical identities drive pending queues and correction answers update only their exact targets", () => {
  const input = {
    readingAttempts: [
      { attemptId: "official-ctw", logicalItemId: "ctw-item", submittedAt: "2026-08-28T10:00:00.000Z", taskType: "ctw" },
      { attemptId: "official-rdl", logicalItemId: "rdl-item", submittedAt: "2026-08-30T10:00:00.000Z", taskType: "rdl" },
      { attemptId: "official-rap", logicalItemId: "rap-item", submittedAt: "2026-08-30T11:00:00.000Z", taskType: "rap" }
    ],
    readingAnswers: [
      { attemptId: "official-ctw", isCorrect: false, questionId: "ctw-q", slotId: "slot-1" },
      { attemptId: "official-ctw", isCorrect: false, questionId: "ctw-q", slotId: "slot-2" },
      { attemptId: "official-rdl", isCorrect: false, questionId: "rdl-q", slotId: null },
      { attemptId: "official-rap", isCorrect: false, questionId: "rap-q", slotId: null }
    ],
    readingCorrectionAttempts: [
      { attemptId: "correction-ctw", logicalItemId: "ctw-item", scope: "history", submittedAt: "2026-08-29T10:00:00.000Z", taskType: "ctw" },
      { attemptId: "correction-rdl", logicalItemId: "rdl-item", scope: "today", submittedAt: "2026-08-30T12:00:00.000Z", taskType: "rdl" }
    ],
    readingCorrectionAnswers: [
      { attemptId: "correction-ctw", isCorrect: true, questionId: "ctw-q", slotId: "slot-1" },
      { attemptId: "correction-rdl", isCorrect: true, questionId: "rdl-q", slotId: null },
      // A correction answer with no official wrong identity must never create an item.
      { attemptId: "correction-rdl", isCorrect: false, questionId: "unrelated-q", slotId: null }
    ],
    readingTitles: new Map([
      ["ctw-item", "套题001"],
      ["rdl-item", "RDL material"],
      ["rap-item", "RAP passage"]
    ]),
    todayStart: Date.parse("2026-08-30T00:00:00.000Z"),
    todayEnd: Date.parse("2026-08-31T00:00:00.000Z")
  };

  const ctwHistory = buildReadingWrongbookQueue({ ...input, scope: "history", taskType: "ctw" });
  assert.deepEqual(ctwHistory.map((item) => item.targets), [[
    { questionId: "ctw-q", sourceAttemptId: "official-ctw", slotId: "slot-2" }
  ]]);
  assert.deepEqual(buildReadingWrongbookQueue({ ...input, scope: "today", taskType: "rdl" }), []);
  assert.deepEqual(
    buildReadingWrongbookQueue({ ...input, scope: "today", taskType: "rap" })[0].targets,
    [{ questionId: "rap-q", sourceAttemptId: "official-rap", slotId: null }]
  );
});

test("Reading Full Set wrongbook keeps one attempt-scoped entry and original mixed occurrence order", () => {
  const sourceA = "11111111-1111-4111-8111-111111111111";
  const sourceB = "22222222-2222-4222-8222-222222222222";
  const attempt = (attemptId, fullSetId, completedAt, title) => ({ attemptId, fullSetId, completedAt, title });
  const answer = (attemptId, occurrenceId, logicalItemId, taskType, moduleNumber, order, questionId, slotId = null, isCorrect = false) => ({
    attemptId, occurrenceId, logicalItemId, taskType, moduleNumber, order, questionId, slotId, isCorrect
  });
  const input = {
    fullSetAttempts: [
      attempt(sourceA, "20260830A", "2026-08-30T08:00:00.000Z", "20260830A"),
      attempt(sourceB, "20260829B", "2026-08-29T08:00:00.000Z", "20260829B")
    ],
    fullSetAnswers: [
      answer(sourceA, "occ-ctw-a", "reading-ctw-aaaaaaaaaaaaaaaaaaaaaaaa", "ctw", 1, 1, "ctw-a", "slot-1"),
      answer(sourceA, "occ-rdl", "reading-rdl-bbbbbbbbbbbbbbbbbbbbbbbb", "rdl", 1, 12, "rdl-q2"),
      answer(sourceA, "occ-rap", "reading-rap-cccccccccccccccccccccccc", "rap", 1, 16, "rap-insertion"),
      answer(sourceA, "occ-ctw-b", "reading-ctw-dddddddddddddddddddddddd", "ctw", 1, 21, "ctw-b", "slot-7"),
      answer(sourceA, "occ-rap-b", "reading-rap-eeeeeeeeeeeeeeeeeeeeeeee", "rap", 1, 34, "rap-selection"),
      answer(sourceB, "occ-other", "reading-rap-ffffffffffffffffffffffff", "rap", 1, 5, "other-q")
    ],
    fullSetCorrectionAttempts: [],
    fullSetCorrectionAnswers: [],
    todayStart: Date.parse("2026-08-30T00:00:00.000Z"),
    todayEnd: Date.parse("2026-08-31T00:00:00.000Z")
  };

  const queue = buildReadingFullSetWrongbookQueue({ ...input, scope: "today", sourceAttemptId: sourceA });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].sourceAttemptId, sourceA);
  assert.deepEqual(queue[0].targets.map((target) => [target.taskType, target.occurrenceId, target.order]), [
    ["ctw", "occ-ctw-a", 1],
    ["rdl", "occ-rdl", 12],
    ["rap", "occ-rap", 16],
    ["ctw", "occ-ctw-b", 21],
    ["rap", "occ-rap-b", 34]
  ]);

  const overview = buildWrongQuestionsOverview({
    basAnswers: [], basAttempts: [], basCorrectionAnswers: [], basGroupsBySet: new Map(),
    readingAnswers: [], readingAttempts: [], readingTitles: new Map(),
    ...input
  });
  const fullSetGroups = overview.groups.filter((group) => group.taskType === "full_set");
  assert.equal(fullSetGroups.length, 2);
  assert.equal(fullSetGroups.find((group) => group.groupId === sourceA).wrongCount, 5);
  assert.match(fullSetGroups.find((group) => group.groupId === sourceA).correctionHref, new RegExp(`sourceAttemptId=${sourceA}`));
});

test("Reading Full Set correction clears only exact source occurrence scoring points", () => {
  const sourceA = "11111111-1111-4111-8111-111111111111";
  const sourceB = "22222222-2222-4222-8222-222222222222";
  const baseTarget = {
    logicalItemId: "reading-ctw-aaaaaaaaaaaaaaaaaaaaaaaa",
    moduleNumber: 1,
    occurrenceId: "occ-ctw",
    order: 1,
    questionId: "ctw-q",
    slotId: "slot-1",
    taskType: "ctw"
  };
  const input = {
    fullSetAttempts: [
      { attemptId: sourceA, completedAt: "2026-08-28T08:00:00.000Z", fullSetId: "20260828A", title: "20260828A" },
      { attemptId: sourceB, completedAt: "2026-08-29T08:00:00.000Z", fullSetId: "20260829B", title: "20260829B" }
    ],
    fullSetAnswers: [
      { ...baseTarget, attemptId: sourceA, isCorrect: false },
      { ...baseTarget, attemptId: sourceB, isCorrect: false }
    ],
    fullSetCorrectionAttempts: [
      { attemptId: "correction-a", sourceAttemptId: sourceA, submittedAt: "2026-08-30T08:00:00.000Z" }
    ],
    fullSetCorrectionAnswers: [
      { ...baseTarget, attemptId: "correction-a", isCorrect: true }
    ],
    scope: "history",
    todayStart: Date.parse("2026-08-30T00:00:00.000Z"),
    todayEnd: Date.parse("2026-08-31T00:00:00.000Z")
  };
  assert.deepEqual(buildReadingFullSetWrongbookQueue({ ...input, sourceAttemptId: sourceA }), []);
  assert.equal(buildReadingFullSetWrongbookQueue({ ...input, sourceAttemptId: sourceB })[0].targets.length, 1);
});

function fullSetProgressTarget(taskType, occurrenceId, questionId, order, slotId = null) {
  return {
    logicalItemId: `reading-${taskType}-${occurrenceId.padEnd(24, "a").slice(0, 24)}`,
    moduleNumber: 1,
    occurrenceId,
    order,
    questionId,
    slotId,
    taskType
  };
}

function fullSetOverviewGroup(targets) {
  const attemptId = "11111111-1111-4111-8111-111111111111";
  const payload = buildWrongQuestionsOverview({
    basAnswers: [], basAttempts: [], basCorrectionAnswers: [], basGroupsBySet: new Map(),
    readingAnswers: [], readingAttempts: [], readingTitles: new Map(),
    fullSetAnswers: targets.map((target) => ({ ...target, attemptId, isCorrect: false })),
    fullSetAttempts: [{ attemptId, completedAt: "2026-08-30T08:00:00.000Z", fullSetId: "20260830A", title: "20260830A" }],
    todayStart: Date.parse("2026-08-30T00:00:00.000Z"),
    todayEnd: Date.parse("2026-08-31T00:00:00.000Z")
  });
  return payload.groups.find((group) => group.taskType === "full_set");
}

test("Full Set progress counts ten wrong CTW slots as ten questions on one screen", () => {
  const targets = Array.from({ length: 10 }, (_, index) =>
    fullSetProgressTarget("ctw", "ctw-all", "ctw-question", index + 1, `slot-${index + 1}`)
  );
  const progress = buildReadingFullSetWrongbookProgress(targets);
  assert.equal(progress.screenCount, 1);
  assert.equal(progress.wrongQuestionCount, 10);
  assert.equal(progress.screens[0].wrongQuestionCount, 10);
  assert.equal(fullSetOverviewGroup(targets).wrongCount, 10);
  assert.equal(fullSetOverviewGroup(targets).pendingCount, 10);
  assert.equal(readingFullSetWrongbookProgressLabel(progress.screens[0], progress.wrongQuestionCount), "第 1–10 / 10 题");
});

test("Full Set progress uses CTW slots plus individual RDL and RAP questions", () => {
  const targets = [
    ...Array.from({ length: 4 }, (_, index) =>
      fullSetProgressTarget("ctw", "ctw-part", "ctw-question", index + 1, `slot-${index + 1}`)
    ),
    ...Array.from({ length: 3 }, (_, index) =>
      fullSetProgressTarget("rdl", "rdl", `rdl-${index + 1}`, index + 11)
    ),
    ...Array.from({ length: 2 }, (_, index) =>
      fullSetProgressTarget("rap", "rap", `rap-${index + 1}`, index + 20)
    )
  ];
  const progress = buildReadingFullSetWrongbookProgress(targets);
  assert.equal(progress.screenCount, 6);
  assert.equal(progress.wrongQuestionCount, 9);
  assert.equal(fullSetOverviewGroup(targets).wrongCount, 9);
  assert.equal(progress.screens[1].wrongQuestionStart, 5);
  assert.equal(readingFullSetWrongbookProgressLabel(progress.screens[1], progress.wrongQuestionCount), "第 5 / 9 题");
  assert.deepEqual(progress.screens.slice(1).map((screen) => screen.wrongQuestionCount), [1, 1, 1, 1, 1]);
});

test("Full Set progress reports sixteen questions instead of seven screens", () => {
  const targets = [
    ...Array.from({ length: 10 }, (_, index) =>
      fullSetProgressTarget("ctw", "ctw-ten", "ctw-question", index + 1, `slot-${index + 1}`)
    ),
    ...Array.from({ length: 3 }, (_, index) =>
      fullSetProgressTarget("rdl", "rdl-six", `rdl-${index + 1}`, index + 11)
    ),
    ...Array.from({ length: 3 }, (_, index) =>
      fullSetProgressTarget("rap", "rap-six", `rap-${index + 1}`, index + 20)
    )
  ];
  const progress = buildReadingFullSetWrongbookProgress(targets);
  assert.equal(progress.screenCount, 7);
  assert.equal(progress.wrongQuestionCount, 16);
  assert.equal(fullSetOverviewGroup(targets).pendingCount, 16);
  assert.equal(progress.screens[1].wrongQuestionStart, 11);
  assert.equal(readingFullSetWrongbookProgressLabel(progress.screens[0], progress.wrongQuestionCount), "第 1–10 / 16 题");
});

test("Full Set pending progress removes only individually corrected CTW slots", () => {
  const sourceAttemptId = "11111111-1111-4111-8111-111111111111";
  const correctionAttemptId = "correction-four-slots";
  const original = Array.from({ length: 10 }, (_, index) => ({
    ...fullSetProgressTarget("ctw", "ctw-pending", "ctw-question", index + 1, `slot-${index + 1}`),
    attemptId: sourceAttemptId,
    isCorrect: false
  }));
  const corrected = original.slice(0, 4).map((answer) => ({
    ...answer,
    attemptId: correctionAttemptId,
    isCorrect: true
  }));
  const queue = buildReadingFullSetWrongbookQueue({
    fullSetAnswers: original,
    fullSetAttempts: [{ attemptId: sourceAttemptId, completedAt: "2026-08-28T08:00:00.000Z", fullSetId: "20260828A", title: "20260828A" }],
    fullSetCorrectionAnswers: corrected,
    fullSetCorrectionAttempts: [{ attemptId: correctionAttemptId, sourceAttemptId, submittedAt: "2026-08-29T08:00:00.000Z" }],
    scope: "history",
    sourceAttemptId,
    todayStart: Date.parse("2026-08-30T00:00:00.000Z"),
    todayEnd: Date.parse("2026-08-31T00:00:00.000Z")
  });
  assert.equal(queue[0].targets.length, 6);
  const progress = buildReadingFullSetWrongbookProgress(queue[0].targets);
  assert.equal(progress.screenCount, 1);
  assert.equal(progress.wrongQuestionCount, 6);
});

test("Reading Full Set correction reuses Reading workspaces, submit route, result chips, and readonly answer renderers", () => {
  const runtime = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingFullSetWrongbookPractice.tsx"), "utf8");
  const review = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingWrongbookReview.tsx"), "utf8");
  const result = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingWrongbookResult.tsx"), "utf8");
  const queueRoute = fs.readFileSync(path.join(projectRoot, "app/api/reading/wrongbook-attempts/route.ts"), "utf8");
  const submitRoute = fs.readFileSync(path.join(projectRoot, "app/api/reading/wrongbook-attempts/[attemptId]/submit/route.ts"), "utf8");
  const migration = fs.readFileSync(path.join(projectRoot, "supabase/reading_full_set_wrongbook_corrections.sql"), "utf8");
  assert.match(runtime, /ReadingWorkspaceRouter/);
  assert.match(runtime, /selectReadingWrongbookPractice/);
  assert.match(runtime, /readingWrongbookEditableSlotIds/);
  assert.match(runtime, /buildReadingWrongbookInitialAnswers/);
  assert.match(runtime, /selectReadingWrongbookSubmissionAnswers/);
  assert.match(runtime, /\/api\/reading\/wrongbook-attempts\/practice\/\$\{encodeURIComponent\(itemId\)\}/);
  assert.match(runtime, /full-set-correction-practice:/);
  assert.doesNotMatch(runtime, /itemIds: itemIds\.join/);
  assert.doesNotMatch(runtime, /Promise\.all\(uniqueOccurrences\.map/);
  assert.match(queueRoute, /loadReadingFullSetWrongbookQueue/);
  assert.match(submitRoute, /submit_reading_full_set_wrongbook_attempt/);
  assert.match(result, /ReadingQuestionStatusChips/);
  assert.doesNotMatch(result, /你的答案|正确答案|ReadingCorrectionAnswerValue/);
  assert.match(review, /ReadingWorkspaceRouter/);
  assert.match(review, /reviewPresentation=\{disclosure\}/);
  assert.match(migration, /source_attempt_id uuid references public\.reading_full_set_attempts/);
  assert.match(migration, /source_occurrence_id text references public\.reading_source_occurrences/);
});

test("wrongbook detail queries are scoped before answers and overview title lookup skips global catalog scans", () => {
  const reading = fs.readFileSync(path.join(projectRoot, "lib/reading/wrongbook.server.ts"), "utf8");
  const fullSet = fs.readFileSync(path.join(projectRoot, "lib/reading/fullSetWrongbook.server.ts"), "utf8");
  const runtime = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingWrongbookPractice.tsx"), "utf8");

  assert.match(reading, /if \(filters\.itemId\) query = query\.eq\("logical_item_id", filters\.itemId\)/);
  assert.match(reading, /if \(filters\.taskType\) query = query\.eq\("task_type", filters\.taskType\)/);
  assert.match(reading, /query: "reading_ctw_rank_catalog"/);
  assert.match(reading, /\.eq\("module", "ctw"\)/);
  assert.match(reading, /\.lte\("first_seen_date", latestCtwDate\)/);
  assert.doesNotMatch(reading, /count: "exact", head: true/);
  assert.match(fullSet, /if \(sourceAttemptId\) query = query\.eq\("attempt_id", sourceAttemptId\)/);
  assert.match(fullSet, /if \(sourceAttemptId\) query = query\.eq\("source_attempt_id", sourceAttemptId\)/);
  assert.match(fullSet, /reading_source_occurrences/);
  assert.doesNotMatch(fullSet, /loadReadingFullSets/);
  assert.match(runtime, /enabled: !itemId/);
  assert.match(runtime, /attemptPayload\.item/);
});

test("Reading homepage CTW rank keeps the exact historical tie-breakers with one catalog read", () => {
  const rows = [
    { logical_item_id: "z", first_seen_date: "2026-01-02", first_seen_source_label: "Set 2", first_seen_source_order: 1 },
    { logical_item_id: "b", first_seen_date: "2026-01-01", first_seen_source_label: "Set 10", first_seen_source_order: 1 },
    { logical_item_id: "c", first_seen_date: "2026-01-01", first_seen_source_label: "Set 2", first_seen_source_order: 2 },
    { logical_item_id: "a", first_seen_date: "2026-01-01", first_seen_source_label: "Set 2", first_seen_source_order: 2 }
  ];
  const legacy = new Map();
  for (const row of rows) {
    const before = rows.filter((candidate) => candidate.first_seen_date < row.first_seen_date).length;
    const sameDay = rows
      .filter((candidate) => candidate.first_seen_date === row.first_seen_date)
      .sort(compareReadingCatalogIdentityOrder);
    legacy.set(row.logical_item_id, String(before + sameDay.findIndex((candidate) => candidate.logical_item_id === row.logical_item_id) + 1).padStart(3, "0"));
  }
  assert.deepEqual(readingCatalogDisplayNumbers(rows), legacy);
});

test("wrongbook orchestration removes BAS and preserved-answer sibling waterfalls", () => {
  const route = fs.readFileSync(path.join(projectRoot, "app/api/wrong-questions/route.ts"), "utf8");
  const reading = fs.readFileSync(path.join(projectRoot, "lib/reading/wrongbook.server.ts"), "utf8");
  assert.match(route, /const questionPromise =[\s\S]*const candidateAnswerPromise =/);
  assert.match(route, /dependsOn: \["bas_correction_answers_lookup"\]/);
  assert.doesNotMatch(route, /dependsOn: \["bas_correction_answers_lookup", "bas_question_metadata_lookup"\]/);
  assert.match(route, /const wrongAnswerResult = await wrongAnswerPromise;[\s\S]*const questionPromise =[\s\S]*Promise\.all\(\[[\s\S]*displayResolverPromise,[\s\S]*questionPromise/);
  assert.match(reading, /const \[ordinaryAttemptsResult, priorCorrectionResult\] = await Promise\.all\(\[/);
  assert.match(reading, /const \[ordinaryAnswers, correctionAnswers\] = await Promise\.all\(\[/);
  assert.match(reading, /\.lte\("submitted_at", input\.before\)/);
  assert.match(reading, /\.\.\.preferredIds,[\s\S]*\.\.\.ordinaryIds\.filter[\s\S]*\.\.\.correctionIds/);
});

test("CTW correction shows only a readonly preview until attempt and preserved answers are ready", () => {
  const runtime = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingWrongbookPractice.tsx"), "utf8");
  const shell = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingPractice.tsx"), "utf8");
  assert.match(runtime, /if \(previewPractice && correctionRequest\.loading\)[\s\S]*ReadingPracticePendingShell/);
  assert.match(runtime, /if \(queue\.error \|\| requestError \|\| ready\?\.error\)/);
  assert.match(runtime, /taskType === "ctw" && raw\.questions\.length === 1/);
  assert.match(runtime, /reading-correction-practice:\$\{logicalItemId\}/);
  assert.match(runtime, /reading-correction-attempt:\$\{scope\}:\$\{taskType\}:\$\{logicalItemId\}/);
  assert.doesNotMatch(runtime, /setPractice|setAttempt|setCurrentItem/);
  assert.match(shell, /data-testid="reading-wrongbook-preview"[\s\S]*readOnly/);
  assert.match(shell, /showElapsed=\{false\}/);
});

test("Reading correction routes reuse the three existing renderers and persist isolated wrongbook attempts", () => {
  const home = fs.readFileSync(path.join(projectRoot, "components/WrongQuestionsHome.tsx"), "utf8");
  const runtime = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingWrongbookPractice.tsx"), "utf8");
  const renderer = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingPractice.tsx"), "utf8");
  const queueRoute = fs.readFileSync(path.join(projectRoot, "app/api/reading/wrongbook-attempts/route.ts"), "utf8");
  const submitRoute = fs.readFileSync(path.join(projectRoot, "app/api/reading/wrongbook-attempts/[attemptId]/submit/route.ts"), "utf8");
  const migration = fs.readFileSync(path.join(projectRoot, "supabase/reading_wrongbook_corrections.sql"), "utf8");

  assert.match(home, /taskType: "ctw" \| "rdl" \| "rap"/);
  assert.match(home, /data-testid=\{`\$\{taskType\}-wrong-question-correction`\}/);
  assert.match(runtime, /ReadingPracticeShell/);
  assert.match(runtime, /selectReadingWrongbookPractice/);
  assert.doesNotMatch(runtime, /full-sets|\/student\/reading\/\$\{taskType\}/);
  assert.match(renderer, /practice\.item\.module === "ctw"[\s\S]*<CtwPracticeWorkspace/);
  assert.match(renderer, /practice\.item\.module === "rdl"[\s\S]*<RdlPracticeWorkspace/);
  assert.match(renderer, /practice\.item\.module === "rap"[\s\S]*<RapPracticeWorkspace/);
  assert.match(renderer, /invalidateStudentWrongbook/);
  assert.match(renderer, /selectReadingWrongbookSubmissionAnswers/);
  assert.match(queueRoute, /loadReadingWrongbookQueue/);
  assert.match(submitRoute, /submit_reading_wrongbook_attempt/);
  assert.match(migration, /create table if not exists public\.reading_wrongbook_attempts/);
  assert.match(migration, /create table if not exists public\.reading_wrongbook_attempt_answers/);
  assert.doesNotMatch(migration, /alter table public\.reading_attempts/);
});

test("CTW correction restores genuine correct slot text while leaving correction targets blank", () => {
  const practice = {
    item: {
      itemId: "ctw-item",
      module: "ctw",
      productName: "Complete the Words",
      questionCount: 1,
      scoringPointCount: 2,
      title: "套题001"
    },
    material: null,
    passage: null,
    questions: [{
      paragraphs: [],
      questionId: "ctw-q",
      questionOrder: 1,
      questionType: "ctw",
      slots: [
        { slotId: "correct-slot", slotOrder: 1, paragraphId: "p", prefix: "pre", missingLength: 3 },
        { slotId: "wrong-slot", slotOrder: 2, paragraphId: "p", prefix: "mis", missingLength: 4 }
      ],
      stem: ""
    }]
  };
  const answers = buildReadingWrongbookInitialAnswers(practice, [{
    answerKind: "ctw_slot",
    isCorrect: true,
    questionId: "ctw-q",
    slotId: "correct-slot",
    studentAnswer: "fix"
  }]);
  assert.deepEqual(answers["ctw-q"].slots, {
    "correct-slot": ["f", "i", "x"],
    "wrong-slot": ["", "", "", ""]
  });
});

test("Reading correction submit opens its exact isolated result and shared submitted review discloses keys", () => {
  const runtime = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingWrongbookPractice.tsx"), "utf8");
  const ordinaryResult = fs.readFileSync(path.join(projectRoot, "app/api/reading/results/[attemptId]/route.ts"), "utf8");
  const correctionResult = fs.readFileSync(path.join(projectRoot, "app/api/reading/wrongbook-attempts/[attemptId]/result/route.ts"), "utf8");
  const correctionReview = fs.readFileSync(path.join(projectRoot, "app/api/reading/wrongbook-attempts/[attemptId]/review/route.ts"), "utf8");
  const ordinaryReview = fs.readFileSync(path.join(projectRoot, "app/api/reading/attempts/[attemptId]/review/route.ts"), "utf8");
  const disclosureLoader = fs.readFileSync(path.join(projectRoot, "lib/reading/reviewDisclosures.server.ts"), "utf8");
  const correctionReviewUi = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingWrongbookReview.tsx"), "utf8");
  const correctionResultUi = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingWrongbookResult.tsx"), "utf8");
  const correctionAnswerUi = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingCorrectionAnswerValue.tsx"), "utf8");
  const practiceUi = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingPractice.tsx"), "utf8");
  const resultSummaryUi = fs.readFileSync(path.join(projectRoot, "components/PracticeResult.tsx"), "utf8");

  assert.doesNotMatch(runtime, /订正已完成/);
  assert.match(runtime, /wrongbook-results\/\$\{encodeURIComponent\(submittedAttempt\.attemptId\)\}/);
  assert.match(correctionResult, /\.from\("reading_wrongbook_attempts"\)[\s\S]*\.eq\("attempt_id", params\.attemptId\)/);
  assert.match(correctionResult, /reading_wrongbook_attempt_answers/);
  assert.match(disclosureLoader, /missing_text|correct_option_id|correct_anchor_id|correct_sentence_id/);
  assert.match(disclosureLoader, /buildReadingCorrectionAnswerPresentations/);
  assert.match(correctionReview, /loadReadingAnswerDisclosures\(db, rows\)/);
  assert.match(ordinaryReview, /loadReadingAnswerDisclosures\(db, rows\)/);
  assert.match(correctionResult, /buildReadingCorrectionResultAnswers/);
  assert.match(correctionReviewUi, /reviewDisclosureLabel="正确答案"/);
  assert.doesNotMatch(correctionResultUi, /你的答案|正确答案/);
  assert.match(correctionResultUi, /ReadingQuestionStatusChips/);
  assert.match(correctionResultUi, /scoreComparison=\{null\}/);
  assert.match(correctionResultUi, /timeComparison=\{null\}/);
  assert.doesNotMatch(correctionResultUi, /reading-correction-answer-cards|cursor-pointer/);
  assert.match(resultSummaryUi, /comparison \? "min-h-\[144px\]" : ""/);
  assert.match(resultSummaryUi, /\{comparison \? \([\s\S]*\{comparison\}[\s\S]*\) : null\}/);
  assert.match(correctionAnswerUi, /data-ctw-correct-fill/);
  assert.match(practiceUi, /ReadingCorrectionAnswerValue answer=\{disclosure\.correctAnswer\}/);
  assert.match(practiceUi, /你的答案/);
  assert.doesNotMatch(`${correctionReviewUi}\n${correctionResultUi}`, /Correct Answer/);
  assert.doesNotMatch(ordinaryResult, /missing_text|correct_option_id|correct_anchor_id|correct_sentence_id/);
});

test("Reading correction summaries map standard choices by option id and option order", () => {
  const answers = buildReadingCorrectionResultAnswers({
    allResultAnswers: [resultAnswer("choice-answer", 1, false)],
    correctionRows: [{
      answer_kind: "option",
      attempt_answer_id: "choice-answer",
      is_correct: false,
      question_id: "q-choice",
      question_time_seconds: 9,
      slot_id: null,
      student_answer: "option-a"
    }],
    questions: [correctionQuestion("q-choice", "rdl", { correct_option_id: "option-b" })],
    options: [
      { option_id: "option-b", option_order: 2, option_text: "Full option B", question_id: "q-choice" },
      { option_id: "option-a", option_order: 1, option_text: "Full option A", question_id: "q-choice" },
      { option_id: "option-d", option_order: 4, option_text: "Full option D", question_id: "q-choice" },
      { option_id: "option-c", option_order: 3, option_text: "Full option C", question_id: "q-choice" }
    ]
  });

  assert.equal(answers[0].studentAnswer, "A");
  assert.deepEqual(answers[0].correctAnswer, { kind: "text", text: "B" });
});

test("choice summaries map sparse option_order values by sorted position", () => {
  const answers = buildReadingCorrectionResultAnswers({
    allResultAnswers: [resultAnswer("choice-answer", 1, true)],
    correctionRows: [{
      answer_kind: "option",
      attempt_answer_id: "choice-answer",
      is_correct: true,
      question_id: "q-choice",
      question_time_seconds: 2,
      slot_id: null,
      student_answer: "option-yes"
    }],
    questions: [correctionQuestion("q-choice", "rap_multiple_choice", { correct_option_id: "option-yes" })],
    options: [
      { option_id: "option-yes", option_order: 10, option_text: "Yes", question_id: "q-choice" },
      { option_id: "option-no", option_order: 20, option_text: "No", question_id: "q-choice" }
    ]
  });

  assert.equal(answers[0].studentAnswer, "A");
  assert.deepEqual(answers[0].correctAnswer, { kind: "text", text: "A" });
});

test("standard choice summaries continue past D using authoritative option order", () => {
  const options = Array.from({ length: 6 }, (_, index) => ({
    option_id: `option-${index + 1}`,
    option_order: index + 1,
    option_text: `Full option ${index + 1}`,
    question_id: "q-choice"
  }));
  const answers = buildReadingCorrectionResultAnswers({
    allResultAnswers: [resultAnswer("choice-answer", 1, false)],
    correctionRows: [{
      answer_kind: "option",
      attempt_answer_id: "choice-answer",
      is_correct: false,
      question_id: "q-choice",
      question_time_seconds: 2,
      slot_id: null,
      student_answer: "option-5"
    }],
    questions: [correctionQuestion("q-choice", "rdl", { correct_option_id: "option-6" })],
    options
  });

  assert.equal(answers[0].studentAnswer, "E");
  assert.deepEqual(answers[0].correctAnswer, { kind: "text", text: "F" });
});

test("RDL and RAP correction reviews mark wrong choices orange and correct choices purple", () => {
  const practiceUi = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingPractice.tsx"), "utf8");
  const choiceSource = practiceUi.slice(
    practiceUi.indexOf("function ChoiceOptionList"),
    practiceUi.indexOf("function ReadingQuestionNavigation")
  );
  const optionTextStateStart = choiceSource.indexOf("const optionTextClassName");
  const optionTextStateSource = choiceSource.slice(
    optionTextStateStart,
    choiceSource.indexOf("return (", optionTextStateStart)
  );
  const optionButtonSource = choiceSource.slice(choiceSource.indexOf("<button"), choiceSource.indexOf("</button>"));
  const optionButtonClassName = optionButtonSource.match(/<button[\s\S]*?className="([^"]+)"/)?.[1] ?? "";
  const options = ["a", "b", "c", "d"].map((letter, index) => ({
    option_id: `option-${letter}`,
    option_order: index + 1,
    option_text: `Option ${letter.toUpperCase()}`,
    question_id: "q-choice"
  }));

  for (const questionType of ["rdl", "rap_multiple_choice"]) {
    const wrong = buildReadingCorrectionResultAnswers({
      allResultAnswers: [resultAnswer("choice-wrong", 1, false)],
      correctionRows: [{
        answer_kind: "option",
        attempt_answer_id: "choice-wrong",
        is_correct: false,
        question_id: "q-choice",
        question_time_seconds: 4,
        slot_id: null,
        student_answer: "option-b"
      }],
      questions: [correctionQuestion("q-choice", questionType, { correct_option_id: "option-d" })],
      options
    });
    assert.equal(wrong[0].studentAnswer, "B");
    assert.deepEqual(wrong[0].correctAnswer, { kind: "text", text: "D" });
    assert.equal(readingCorrectionMarkState(wrong[0], "choice", "option-b"), "incorrect");
    assert.equal(readingCorrectionMarkState(wrong[0], "choice", "option-d"), "correct");

    const correct = buildReadingCorrectionResultAnswers({
      allResultAnswers: [resultAnswer("choice-correct", 1, true)],
      correctionRows: [{
        answer_kind: "option",
        attempt_answer_id: "choice-correct",
        is_correct: true,
        question_id: "q-choice",
        question_time_seconds: 3,
        slot_id: null,
        student_answer: "option-d"
      }],
      questions: [correctionQuestion("q-choice", questionType, { correct_option_id: "option-d" })],
      options
    });
    assert.equal(readingCorrectionMarkState(correct[0], "choice", "option-d"), "correct");
    assert.equal(readingCorrectionMarkState(correct[0], "choice", "option-b"), null);

    const unanswered = buildReadingCorrectionResultAnswers({
      allResultAnswers: [{ ...resultAnswer("choice-unanswered", 1, false), isAnswered: false }],
      correctionRows: [{
        answer_kind: "option",
        attempt_answer_id: "choice-unanswered",
        is_correct: false,
        question_id: "q-choice",
        question_time_seconds: 1,
        slot_id: null,
        student_answer: null
      }],
      questions: [correctionQuestion("q-choice", questionType, { correct_option_id: "option-d" })],
      options
    });
    assert.equal(unanswered[0].studentAnswer, "未作答");
    assert.equal(readingCorrectionMarkState(unanswered[0], "choice", "option-d"), "correct");
    assert.equal(readingCorrectionMarkState(unanswered[0], "choice", "option-b"), null);
  }

  assert.match(choiceSource, /readingCorrectionMarkState\(reviewPresentation, "choice", option\.optionId\)/);
  assert.match(optionTextStateSource, /font-bold text-student-primary/);
  assert.match(optionTextStateSource, /font-bold text-student-error/);
  assert.doesNotMatch(optionTextStateSource, /bg-student-(?:primary|error)|text-white/);
  assert.doesNotMatch(optionTextStateSource, /line-through|decoration-2/);
  assert.match(choiceSource, /<span className=\{optionTextClassName\} data-option-text-state=\{correctionState \?\? undefined\}>\{option\.text\}<\/span>/);
  assert.doesNotMatch(optionButtonClassName, /(?:^|\s)bg-student-(?:primary|error)(?:\s|$)/);
  assert.match(optionButtonSource, /className="flex w-full items-start rounded-lg text-left font-normal text-student-text transition-colors hover:bg-student-primary-soft\/40/);
  assert.match(optionButtonSource, /style=\{\{ \.\.\.readingQuestionTextStyle, \.\.\.readingChoiceStyle \}\}/);
  assert.match(optionButtonSource, /selected \? "border-student-primary" : "border-student-muted"/);
  assert.match(optionButtonSource, /selected \? <span className="rounded-full bg-student-primary" style=\{readingRadioDotStyle\} \/> : null/);
  assert.match(choiceSource, /style=\{readingChoiceListStyle\}/);
});

test("Reading homepage item links keep the complete correction lifecycle and reachable Submit", () => {
  const home = fs.readFileSync(path.join(projectRoot, "components/WrongQuestionsHome.tsx"), "utf8");
  const runtime = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingWrongbookPractice.tsx"), "utf8");
  const shell = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingPractice.tsx"), "utf8");
  const todayPage = fs.readFileSync(path.join(projectRoot, "app/student/wrong-questions/today/reading/practice/page.tsx"), "utf8");
  const historyPage = fs.readFileSync(path.join(projectRoot, "app/student/wrong-questions/history/reading/practice/page.tsx"), "utf8");

  assert.match(home, /group\.correctionHref/);
  assert.match(runtime, /if \(itemId\) params\.set\("itemId", itemId\)/);
  assert.match(runtime, /body: JSON\.stringify\(\{[\s\S]*itemId: input\.logicalItemId,[\s\S]*scope: input\.scope,[\s\S]*taskType: input\.taskType/);
  assert.match(runtime, /<ReadingPracticeShell[\s\S]*wrongbook=\{\{/);
  assert.doesNotMatch(runtime, /document\.(body|documentElement)\.style\.overflow/);
  assert.match(shell, /wrongbook[\s\S]*selectReadingWrongbookSubmissionAnswers/);
  assert.match(shell, /if \(module === "ctw" && !readOnly\)[\s\S]*submitLabel=/);
  assert.match(shell, /canGoNext \? \([\s\S]*Submit/);
  assert.match(todayPage, /itemId=\{searchParams\.itemId\}/);
  assert.match(historyPage, /itemId=\{searchParams\.itemId\}/);
});

test("CTW correction summaries rebuild the complete word and mark every missing letter", () => {
  const answers = buildReadingCorrectionResultAnswers({
    allResultAnswers: [resultAnswer("ctw-answer", 3, false)],
    correctionRows: [{
      answer_kind: "ctw_slot",
      attempt_answer_id: "ctw-answer",
      is_correct: false,
      question_id: "q-ctw",
      question_time_seconds: 4,
      slot_id: "slot-3",
      student_answer: "a"
    }],
    questions: [correctionQuestion("q-ctw", "ctw")],
    ctwSlots: [{
      answer: "work",
      display_text: "w_rk",
      missing_text: "o",
      prefix: "w",
      question_id: "q-ctw",
      slot_id: "slot-3"
    }]
  });

  assert.equal(answers[0].studentAnswer, "wark");
  assert.deepEqual(answers[0].correctAnswer, {
    kind: "ctw_word",
    parts: [
      { emphasized: false, text: "w" },
      { emphasized: true, text: "o" },
      { emphasized: false, text: "rk" }
    ]
  });

  const multiLetter = buildReadingCorrectionResultAnswers({
    allResultAnswers: [resultAnswer("multi-ctw-answer", 4, true)],
    correctionRows: [{
      answer_kind: "ctw_slot",
      attempt_answer_id: "multi-ctw-answer",
      is_correct: true,
      question_id: "q-ctw",
      question_time_seconds: 3,
      slot_id: "slot-4",
      student_answer: "ation"
    }],
    questions: [correctionQuestion("q-ctw", "ctw")],
    ctwSlots: [{
      answer: "population",
      display_text: "popul_____",
      missing_text: "ation",
      prefix: "popul",
      question_id: "q-ctw",
      slot_id: "slot-4"
    }]
  });
  assert.equal(multiLetter[0].studentAnswer, "population");
  assert.deepEqual(multiLetter[0].correctAnswer, {
    kind: "ctw_word",
    parts: [
      { emphasized: false, text: "popul" },
      { emphasized: true, text: "ation" }
    ]
  });
});

test("RAP insertion and sentence-selection summaries use their natural answer forms", () => {
  const answers = buildReadingCorrectionResultAnswers({
    allResultAnswers: [
      resultAnswer("insertion-answer", 2, false),
      resultAnswer("sentence-answer", 3, false)
    ],
    correctionRows: [
      {
        answer_kind: "insertion_anchor",
        attempt_answer_id: "insertion-answer",
        is_correct: false,
        question_id: "q-insertion",
        question_time_seconds: 5,
        slot_id: null,
        student_answer: "anchor-1"
      },
      {
        answer_kind: "sentence_selection",
        attempt_answer_id: "sentence-answer",
        is_correct: false,
        question_id: "q-sentence",
        question_time_seconds: 6,
        slot_id: null,
        student_answer: "sentence-1"
      }
    ],
    questions: [
      correctionQuestion("q-insertion", "rap_sentence_insertion", { correct_anchor_id: "anchor-3" }),
      correctionQuestion("q-sentence", "rap_sentence_selection", { correct_sentence_id: "sentence-3" })
    ],
    anchors: [
      { anchor_id: "anchor-1", anchor_order: 1, question_id: "q-insertion" },
      { anchor_id: "anchor-3", anchor_order: 3, question_id: "q-insertion" }
    ],
    sentences: [
      { sentence_id: "sentence-1", sentence_order: 1, sentence_text: "The student's selected sentence." },
      { sentence_id: "sentence-3", sentence_order: 3, sentence_text: "The correct selected sentence." }
    ]
  });

  assert.equal(answers[0].studentAnswer, "Position 1");
  assert.deepEqual(answers[0].correctAnswer, { kind: "text", text: "Position 3" });
  assert.equal(answers[1].studentAnswer, "Sentence 1");
  assert.deepEqual(answers[1].correctAnswer, { kind: "text", text: "Sentence 3" });
  assert.equal(readingCorrectionMarkState(answers[0], "insertion", "anchor-1"), "incorrect");
  assert.equal(readingCorrectionMarkState(answers[0], "insertion", "anchor-3"), "correct");
  assert.equal(readingCorrectionMarkState(answers[1], "sentence_selection", "sentence-1"), "incorrect");
  assert.equal(readingCorrectionMarkState(answers[1], "sentence_selection", "sentence-2"), null);
  assert.equal(readingCorrectionMarkState(answers[1], "sentence_selection", "sentence-3"), "correct");

  const correctInsertion = buildReadingCorrectionResultAnswers({
    allResultAnswers: [resultAnswer("correct-insertion", 1, true)],
    correctionRows: [{
      answer_kind: "insertion_anchor",
      attempt_answer_id: "correct-insertion",
      is_correct: true,
      question_id: "q-insertion",
      question_time_seconds: 2,
      slot_id: null,
      student_answer: "anchor-2"
    }],
    questions: [correctionQuestion("q-insertion", "rap_sentence_insertion", { correct_anchor_id: "anchor-2" })],
    anchors: [
      { anchor_id: "anchor-1", anchor_order: 1, question_id: "q-insertion" },
      { anchor_id: "anchor-2", anchor_order: 2, question_id: "q-insertion" }
    ]
  });
  assert.equal(readingCorrectionMarkState(correctInsertion[0], "insertion", "anchor-2"), "correct");
  assert.equal(readingCorrectionMarkState(correctInsertion[0], "insertion", "anchor-1"), null);

  const correctSelection = buildReadingCorrectionResultAnswers({
    allResultAnswers: [resultAnswer("correct-selection", 1, true)],
    correctionRows: [{
      answer_kind: "sentence_selection",
      attempt_answer_id: "correct-selection",
      is_correct: true,
      question_id: "q-sentence",
      question_time_seconds: 2,
      slot_id: null,
      student_answer: "sentence-2"
    }],
    questions: [correctionQuestion("q-sentence", "rap_sentence_selection", { correct_sentence_id: "sentence-2" })],
    sentences: [{ sentence_id: "sentence-2", sentence_order: 2, sentence_text: "The correct selected sentence." }]
  });
  assert.equal(readingCorrectionMarkState(correctSelection[0], "sentence_selection", "sentence-2"), "correct");
  assert.equal(readingCorrectionMarkState(correctSelection[0], "sentence_selection", "sentence-1"), null);
  assert.equal(readingCorrectionMarkState(correctSelection[0], "choice", "sentence-2"), null);

  const practiceUi = fs.readFileSync(path.join(projectRoot, "components/reading/ReadingPractice.tsx"), "utf8");
  assert.match(practiceUi, /readingCorrectionMarkState\(reviewPresentation, "insertion", anchor\.anchorId\)/);
  assert.match(practiceUi, /font-bold text-student-error line-through decoration-2/);
  assert.match(practiceUi, /data-strikethrough=\{correctionState === "incorrect" \? "true" : undefined\}/);
  assert.match(practiceUi, /readingCorrectionMarkState\(reviewPresentation, "sentence_selection", sentence\.sentenceId\)/);
  assert.match(practiceUi, /font-bold text-student-error/);
  assert.match(practiceUi, /readOnly \? "cursor-text select-text" : "cursor-pointer"/);
  assert.match(practiceUi, /style=\{readOnly \? undefined : rapFramelessInteractionStyle\}/);
});

function resultAnswer(answerId, order, isCorrect) {
  return {
    answerId,
    isAnswered: true,
    isCorrect,
    order,
    questionId: `question-${order}`,
    questionTimeSeconds: order
  };
}

function correctionQuestion(questionId, questionType, overrides = {}) {
  return {
    correct_anchor_id: null,
    correct_option_id: null,
    correct_sentence_id: null,
    question_id: questionId,
    question_order: 1,
    question_type: questionType,
    ...overrides
  };
}

test("BAS correction routes use explicit isolated scopes and freeze the loaded question list", () => {
  const historyPage = fs.readFileSync(path.join(
    projectRoot,
    "app/student/wrong-questions/history/practice/page.tsx"
  ), "utf8");
  const todayPage = fs.readFileSync(path.join(
    projectRoot,
    "app/student/wrong-questions/today/practice/page.tsx"
  ), "utf8");
  const practice = fs.readFileSync(path.join(projectRoot, "components/WrongQuestions.tsx"), "utf8");
  const home = fs.readFileSync(path.join(projectRoot, "components/WrongQuestionsHome.tsx"), "utf8");
  const route = fs.readFileSync(path.join(projectRoot, "app/api/wrong-questions/route.ts"), "utf8");
  const session = fs.readFileSync(path.join(projectRoot, "components/PracticeSession.tsx"), "utf8");

  assert.match(historyPage, /scope !== "entry" && scope !== "history"/);
  assert.match(historyPage, /scope === "entry" && !searchParams\.groupId/);
  assert.match(historyPage, /groupId=\{searchParams\.groupId\}[\s\S]*scope=\{scope\}/);
  assert.match(todayPage, /<WrongQuestionsPractice scope="today" \/>/);
  assert.doesNotMatch(`${historyPage}\n${todayPage}\n${practice}`, /questionId\??:/);
  assert.match(home, /today\/practice\?scope=today/);
  assert.match(home, /history\/practice\?scope=history&mode=all/);
  assert.match(practice, /scope: "entry" \| "history" \| "today"/);
  assert.match(practice, /if \(scope === "today"\) return `wrongbook-today-/);
  assert.match(practice, /return `wrongbook-all-/);
  assert.match(practice, /if \(scope === "entry" && groupId\) params\.set\("groupId", groupId\)/);
  assert.match(route, /scope !== "entry" && scope !== "today" && scope !== "history"/);
  assert.match(route, /if \(scope === "entry" && !groupId\)/);
  assert.match(route, /buildBasWrongbookEntryQuestionIds/);
  assert.match(practice, /setQuestionSnapshot\(\{ key: sessionKey, questions: \[\.\.\.questions\] \}\)/);
  assert.match(practice, /questionSnapshot\?\.key === sessionKey[\s\S]*questionSnapshot\.questions/);
  assert.match(practice, /initialQuestions=\{sessionQuestions\}/);
  assert.match(session, /const questions = useMemo\([\s\S]*initialQuestions \?\? cachedQuestions \?\? \[\]/);
  assert.match(session, /const isLastQuestion = currentIndex === questions\.length - 1/);
  assert.match(session, /if \(isLastQuestion\) \{[\s\S]*await submitAll\(savedAnswers\)[\s\S]*return;[\s\S]*setCurrentIndex\(\(index\) => index \+ 1\)/);
  assert.match(session, /questions\.map\(\(question\) => question\.question_id\)/);
  const goNext = session.slice(
    session.indexOf("async function goNext"),
    session.indexOf("async function endPractice")
  );
  assert.doesNotMatch(goNext, /isCorrect|invalidate/);
  assert.match(session, /enabled: !usesProvidedQuestions/);
  assert.match(session, /loadPracticeQuestions\(setId, session\)/);
});

test("BAS entry scope returns exactly the card pending count for 9, 3, and 1 questions", () => {
  const todayStart = Date.parse("2026-08-30T00:00:00.000Z");
  const todayEnd = Date.parse("2026-08-31T00:00:00.000Z");

  for (const { correctedCount, expectedPending, wrongCount } of [
    { correctedCount: 1, expectedPending: 9, wrongCount: 10 },
    { correctedCount: 0, expectedPending: 3, wrongCount: 3 },
    { correctedCount: 0, expectedPending: 1, wrongCount: 1 }
  ]) {
    const basAnswers = Array.from({ length: wrongCount }, (_, index) => basAnswer({
      answerId: `wrong-${wrongCount}-${index}`,
      attemptId: `bas-${wrongCount}`,
      finalSentence: `Unique wrong sentence ${wrongCount}-${index}.`,
      grammarTag: "时态",
      isCorrect: false,
      questionId: `bas-q-${wrongCount}-${index}`,
      time: `2026-08-30T08:${String(index).padStart(2, "0")}:00.000Z`
    }));
    const basCorrectionAnswers = correctedCount === 0 ? [] : [basAnswer({
      answerId: `corrected-${wrongCount}`,
      attemptId: "wrongbook-all-correction",
      finalSentence: `Unique wrong sentence ${wrongCount}-0.`,
      grammarTag: "时态",
      isCorrect: true,
      questionId: `bas-q-${wrongCount}-0`,
      time: "2026-08-30T09:00:00.000Z"
    })];
    const input = {
      basAttempts: [basAttempt(`bas-${wrongCount}`, "2026-08-30T08:00:00.000Z")],
      basAnswers,
      basCorrectionAnswers,
      basGroupsBySet: new Map([["bas-source-112", { groupId: "logical-bas-091", title: "套题091" }]]),
      todayStart,
      todayEnd
    };
    const payload = buildWrongQuestionsOverview({
      ...input,
      readingAnswers: [],
      readingAttempts: [],
      readingTitles: new Map()
    });
    const entryQuestionIds = buildBasWrongbookEntryQuestionIds({
      ...input,
      groupId: "logical-bas-091"
    });

    assert.equal(payload.groups[0].wrongCount, wrongCount);
    assert.equal(payload.groups[0].correctedCount, correctedCount);
    assert.equal(payload.groups[0].pendingCount, expectedPending);
    assert.equal(entryQuestionIds.length, expectedPending);
    assert.equal(
      payload.groups[0].correctionHref,
      "/student/wrong-questions/history/practice?scope=entry&groupId=logical-bas-091"
    );
  }
});

test("BAS today scope aggregates sets and clears only through today correction", () => {
  const todayStart = Date.parse("2026-08-30T00:00:00.000Z");
  const todayEnd = Date.parse("2026-08-31T00:00:00.000Z");
  const attempts = [
    { attemptId: "set-a", createdAt: null, setId: "raw-set-a", submittedAt: "2026-08-30T08:00:00.000Z" },
    { attemptId: "set-b", createdAt: null, setId: "raw-set-b", submittedAt: "2026-08-30T09:00:00.000Z" }
  ];
  const answers = [
    ...Array.from({ length: 2 }, (_, index) => ({ attemptId: "set-a", isCorrect: false, questionId: `a-${index}` })),
    ...Array.from({ length: 3 }, (_, index) => ({ attemptId: "set-b", isCorrect: false, questionId: `b-${index}` }))
  ];
  assert.equal(buildBasWrongbookPracticeQuestionIds({
    answers,
    attempts,
    scope: "today",
    todayEnd,
    todayStart
  }).length, 5);

  const correctionAttempt = {
    attemptId: "today-correction",
    createdAt: null,
    setId: "wrongbook-today-20260830",
    submittedAt: "2026-08-30T10:00:00.000Z"
  };
  const correctedAnswers = answers.map((answer) => ({
    attemptId: correctionAttempt.attemptId,
    isCorrect: true,
    questionId: answer.questionId
  }));
  assert.deepEqual(buildBasWrongbookPracticeQuestionIds({
    answers: [...answers, ...correctedAnswers],
    attempts: [...attempts, correctionAttempt],
    scope: "today",
    todayEnd,
    todayStart
  }), []);
});

test("BAS history scope keeps all 80 historical errors after correction", () => {
  const attempts = [
    { attemptId: "history-source", createdAt: null, setId: "raw-history", submittedAt: "2026-08-20T08:00:00.000Z" },
    { attemptId: "history-correction", createdAt: null, setId: "wrongbook-all-correction", submittedAt: "2026-08-30T08:00:00.000Z" }
  ];
  const wrongAnswers = Array.from({ length: 80 }, (_, index) => ({
    attemptId: "history-source",
    isCorrect: false,
    questionId: `history-${index}`
  }));
  const correctionAnswers = wrongAnswers.map((answer) => ({
    attemptId: "history-correction",
    isCorrect: true,
    questionId: answer.questionId
  }));
  const history = buildBasWrongbookPracticeQuestionIds({
    answers: [...wrongAnswers, ...correctionAnswers],
    attempts,
    scope: "history",
    todayEnd: Date.parse("2026-08-31T00:00:00.000Z"),
    todayStart: Date.parse("2026-08-30T00:00:00.000Z")
  });
  assert.equal(history.length, 80);
  assert.equal(new Set(history).size, 80);
});

test("BAS entry, today, and history scopes stay isolated", () => {
  const todayStart = Date.parse("2026-08-30T00:00:00.000Z");
  const todayEnd = Date.parse("2026-08-31T00:00:00.000Z");
  const basAttempts = [
    basAttempt("set-a", "2026-08-30T08:00:00.000Z", "raw-set-a"),
    basAttempt("set-b", "2026-08-30T09:00:00.000Z", "raw-set-b"),
    basAttempt("set-old", "2026-08-20T08:00:00.000Z", "raw-set-old")
  ];
  const makeAnswers = (attemptId, prefix, count, day) => Array.from(
    { length: count },
    (_, index) => basAnswer({
      answerId: `${prefix}-${index}`,
      attemptId,
      finalSentence: `${prefix} sentence ${index}.`,
      grammarTag: "时态",
      isCorrect: false,
      questionId: `${prefix}-q-${index}`,
      time: `${day}T08:${String(index).padStart(2, "0")}:00.000Z`
    })
  );
  const basAnswers = [
    ...makeAnswers("set-a", "a", 2, "2026-08-30"),
    ...makeAnswers("set-b", "b", 3, "2026-08-30"),
    ...makeAnswers("set-old", "old", 4, "2026-08-20")
  ];
  const entry = buildBasWrongbookEntryQuestionIds({
    basAnswers,
    basAttempts,
    basCorrectionAnswers: [],
    basGroupsBySet: new Map([
      ["raw-set-a", { groupId: "group-a", title: "套题091" }],
      ["raw-set-b", { groupId: "group-b", title: "套题092" }],
      ["raw-set-old", { groupId: "group-old", title: "套题080" }]
    ]),
    groupId: "group-a",
    todayEnd,
    todayStart
  });
  const queueAttempts = basAttempts.map((attempt) => ({
    attemptId: attempt.attemptId,
    createdAt: null,
    setId: attempt.setId,
    submittedAt: attempt.submittedAt
  }));
  const queueAnswers = basAnswers.map((answer) => ({
    attemptId: answer.attemptId,
    isCorrect: answer.isCorrect,
    questionId: answer.questionId
  }));
  const today = buildBasWrongbookPracticeQuestionIds({
    answers: queueAnswers,
    attempts: queueAttempts,
    scope: "today",
    todayEnd,
    todayStart
  });
  const history = buildBasWrongbookPracticeQuestionIds({
    answers: queueAnswers,
    attempts: queueAttempts,
    scope: "history",
    todayEnd,
    todayStart
  });

  assert.deepEqual(entry, ["a-q-1", "a-q-0"]);
  assert.equal(today.length, 5);
  assert.equal(history.length, 9);
  assert.ok(today.includes("b-q-0"));
  assert.ok(!entry.includes("b-q-0"));
  assert.ok(history.includes("old-q-0"));
  assert.ok(!today.includes("old-q-0"));
});

test("a fully corrected BAS group has no correction target", () => {
  const payload = buildWrongQuestionsOverview({
    basAttempts: [basAttempt("bas-old", "2026-08-28T08:00:00.000Z")],
    basAnswers: [basAnswer({
      answerId: "wrong",
      attemptId: "bas-old",
      finalSentence: "A corrected sentence.",
      grammarTag: "时态",
      isCorrect: false,
      questionId: "bas-q-old",
      time: "2026-08-28T08:00:00.000Z"
    })],
    basCorrectionAnswers: [basAnswer({
      answerId: "corrected",
      attemptId: "wrongbook-all",
      finalSentence: "A corrected sentence.",
      grammarTag: "时态",
      isCorrect: true,
      questionId: "bas-q-old",
      time: "2026-08-29T08:00:00.000Z"
    })],
    basGroupsBySet: new Map([["bas-source-112", { groupId: "logical-bas-112", title: "套题112" }]]),
    readingAnswers: [],
    readingAttempts: [],
    readingTitles: new Map(),
    todayStart: Date.parse("2026-08-30T00:00:00.000Z"),
    todayEnd: Date.parse("2026-08-31T00:00:00.000Z")
  });

  assert.equal(payload.groups[0].pendingCount, 0);
  assert.equal(payload.groups[0].correctedCount, 1);
  assert.equal(payload.groups[0].correctionHref, null);
});
