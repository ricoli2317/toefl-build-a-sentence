const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  nextWrongQuestionHistoryAmount,
  readingWrongAnswerEvents
} = require("../lib/wrongQuestionBank.ts");
const {
  buildReadingResultPayload
} = require("../lib/reading/history.ts");
const {
  buildSubmittedReadingAnswerState,
  buildSubmittedReadingReviewItems
} = require("../lib/reading/review.ts");
const {
  buildReadingWrongbookInitialAnswers,
  readingWrongbookEditableSlotIds,
  selectReadingWrongbookPractice
} = require("../lib/reading/wrongbook.ts");
const {
  buildReadingWrongbookSessionReviewPayload,
  findReadingWrongbookSessionShapeIndex,
  mergeReadingWrongbookSessionResults,
  readingWrongbookSessionProgressLabel,
  readingWrongbookSessionResumeHref,
  resolveReadingWrongbookSessionReviewShape
} = require("../lib/reading/wrongbookSession.ts");
const {
  getReadingCorrectionResultNavigation,
  getReadingResultNavigation,
  getStudentResultNavigation,
  safeStudentReturnTo,
  withStudentReturnTo
} = require("../lib/studentNavigation.ts");
const {
  readingQuestionNavigationTargets
} = require("../lib/reading/practiceState.ts");

const projectRoot = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

// ---------------------------------------------------------------------------
// 1. CTW slot classification: wrong, unanswered, and correct slots
// ---------------------------------------------------------------------------

test("1. unanswered CTW slots create wrong-question events exactly like answered wrong slots", () => {
  const events = readingWrongAnswerEvents({
    answers: [
      { isCorrect: false, questionId: "q1", slotId: "slot-1" }, // answered wrong
      { isCorrect: false, questionId: "q1", slotId: "slot-2" }, // unanswered (scored wrong)
      { isCorrect: true, questionId: "q1", slotId: "slot-3" }   // answered correct
    ],
    logicalItemId: "reading-ctw-item",
    taskType: "ctw"
  });
  assert.deepEqual(events.map((event) => [event.event, event.slotId]), [
    ["wrong", "slot-1"],
    ["wrong", "slot-2"]
  ]);
});

test("1. the live event mapper treats a not-explicitly-correct row as wrong and never drops it", () => {
  const events = read("lib/reading/wrongQuestionEvents.server.ts");
  // Unanswered / unscored rows (is_correct false or null) must not be filtered
  // out before the wrong-answer event mapping runs.
  assert.match(events, /isCorrect: answer\.is_correct === true/);
  assert.doesNotMatch(events, /\.filter\(\(answer\) => answer\.is_correct !== null\)/);
  // Full Set rows: only an explicit true is correct; false / null rows become
  // wrong questions.
  assert.match(events, /if \(answer\.is_correct === true \|\| !answer\.logical_item_id\) continue;/);
  assert.doesNotMatch(events, /answer\.is_correct !== false/);

  const wrongbookRoute = read("app/api/reading/wrongbook-attempts/route.ts");
  assert.match(wrongbookRoute, /if \(row\.is_correct === true\) continue;/);
  assert.doesNotMatch(wrongbookRoute, /\.eq\("is_correct", false\)/);
});

// ---------------------------------------------------------------------------
// 2. Drawn slots vs. fillable slots
// ---------------------------------------------------------------------------

test("2. only the drawn targets of a material are editable, never its other slots", () => {
  const drawnTargets = [
    { questionId: "q1", slotId: "slot-1" },
    { questionId: "q1", slotId: "slot-2" }
  ];
  const editable = readingWrongbookEditableSlotIds(drawnTargets);
  assert.deepEqual([...editable], ["slot-1", "slot-2"]);
  assert.equal(editable.has("slot-3"), false);
  assert.equal(editable.has("slot-4"), false);

  const bank = read("components/reading/ReadingWrongbookBankPractice.tsx");
  // The session workspace is gated by the frozen group targets only.
  assert.match(bank, /targets: group\?\.targets \?\? \[\]/);
  const shell = read("components/reading/ReadingPractice.tsx");
  assert.match(shell, /const wrongbookTargets = session \? session\.targets : wrongbook\?\.targets;/);
  assert.match(shell, /readingWrongbookEditableSlotIds\(wrongbookTargets\)/);
});

test("2. a partially drawn CTW material numbers only its drawn points", () => {
  assert.equal(
    readingWrongbookSessionProgressLabel({
      currentIndex: 0,
      groupStart: 1,
      module: "ctw",
      targetCount: 2,
      totalPoints: 15
    }),
    "第 2–3 / 15 题"
  );
});

// ---------------------------------------------------------------------------
// 3. Cross-source Previous / Next
// ---------------------------------------------------------------------------

test("3. session Previous crosses sources while normal in-source movement is unchanged", () => {
  const shell = read("components/reading/ReadingPractice.tsx");
  const bank = read("components/reading/ReadingWrongbookBankPractice.tsx");

  // Previous stays enabled on the first workspace while a previous source exists.
  assert.match(shell, /canGoPrevious=\{navigation\.currentIndex > 0 \|\| Boolean\(session\?\.hasPreviousSource\)\}/);
  assert.match(shell, /if \(session\?\.hasPreviousSource && !session\.pending && !session\.submitting\) \{\n\s+session\.onPreviousSource\?\.\(\);/);

  // The session moves to the previous group and re-opens it at its last
  // workspace; forward progress always re-enters at the first workspace.
  assert.match(bank, /const \[sourceEntryIndex, setSourceEntryIndex\] = useState\(0\)/);
  assert.match(bank, /setSourceEntryIndex\(Math\.max\(0, target\.targets\.length - 1\)\)/);
  assert.match(bank, /setSourceEntryIndex\(0\);\n\s+setSourcePendingText\("正在加载下一篇材料\.\.\."\);/);
  assert.match(bank, /hasPreviousSource,/);
  assert.match(bank, /onPreviousSource: handlePreviousSource,/);

  // The shell restores the requested workspace index when the source payload
  // changes, and the existing in-source move helper is untouched.
  assert.match(shell, /Math\.min\(created\.workspaceCount - 1, session\?\.sourceEntryIndex \?\? 0\)/);
  assert.match(shell, /const next = moveReadingNavigation\(current, direction\);/);
});

test("3. a source re-entered through Previous never creates or re-submits attempts", () => {
  const bank = read("components/reading/ReadingWrongbookBankPractice.tsx");
  assert.match(bank, /if \(rendered\.ready\.attempt\.status === "submitted"\) \{/);
  // The read-only re-entry is shown with a notice, not by rebuilding a draft.
  const shell = read("components/reading/ReadingPractice.tsx");
  assert.match(shell, /data-testid="reading-session-workspace-submitted"/);
  assert.match(shell, /本篇材料已提交，当前为只读回看/);
  // Answers stay in the per-source map across switches: only missing entries
  // are seeded, existing ones are never overwritten.
  assert.match(bank, /setAnswersByGroup\(\(map\) => map\[group\.logicalItemId\]/);
  assert.match(bank, /\? map\n\s+: \{ \.\.\.map, \[group\.logicalItemId\]: groupReady\.initialAnswers \}/);
});

// ---------------------------------------------------------------------------
// 4. Result aggregation: partially drawn CTW sources stay loadable
// ---------------------------------------------------------------------------

test("4. a partially drawn CTW correction result renders neutral blanks instead of failing", () => {
  const correctionRow = {
    attempt_answer_id: "answer-1",
    answer_kind: "ctw_slot",
    is_correct: false,
    question_id: "question-ctw",
    question_time_seconds: 30,
    slot_id: "slot-1",
    student_answer: null
  };
  // Warming up the fixture signature keeps the helper simple.
  const result = buildReadingResultPayload({
    allowDisplayAnswerCountMismatch: true,
    answers: [correctionRow],
    attempt: {
      attempt_id: "attempt-ctw",
      correct_points: 0,
      elapsed_seconds: 950,
      logical_item_id: "reading-ctw-item",
      submitted_at: "2026-09-30T10:00:00.000Z",
      task_type: "ctw",
      total_points: 1
    },
    ctwParagraphs: [{ question_id: "question-ctw", paragraph_id: "paragraph-1", paragraph_order: 1 }],
    ctwSegments: [
      { question_id: "question-ctw", paragraph_id: "paragraph-1", segment_order: 1, segment_type: "blank", text_content: null, slot_id: "slot-1" },
      { question_id: "question-ctw", paragraph_id: "paragraph-1", segment_order: 2, segment_type: "blank", text_content: null, slot_id: "slot-2" }
    ],
    item: { logical_item_id: "reading-ctw-item", module: "ctw", title: "CTW" },
    questions: [{ question_id: "question-ctw", question_order: 1, question_type: "ctw" }],
    slots: [
      { question_id: "question-ctw", slot_id: "slot-1", slot_order: 1, prefix: "" },
      { question_id: "question-ctw", slot_id: "slot-2", slot_order: 2, prefix: "" }
    ],
    tolerateMissingCtwAnswers: true
  });
  assert.deepEqual(result.answers.map((answer) => answer.answerId), ["answer-1"]);
  const missingSegment = result.ctwParagraphs[0].segments[1];
  assert.deepEqual(missingSegment, {
    kind: "blank",
    answerId: "",
    isAnswered: false,
    isCorrect: false,
    order: 2,
    prefix: "",
    studentAnswer: ""
  });

  // The strict ordinary-attempt contract is unchanged.
  assert.throws(() => buildReadingResultPayload({
    answers: [correctionRow],
    attempt: {
      attempt_id: "attempt-ctw",
      correct_points: 0,
      elapsed_seconds: 10,
      logical_item_id: "reading-ctw-item",
      submitted_at: "2026-09-30T10:00:00.000Z",
      task_type: "ctw",
      total_points: 1
    },
    ctwParagraphs: [{ question_id: "question-ctw", paragraph_id: "paragraph-1", paragraph_order: 1 }],
    ctwSegments: [
      { question_id: "question-ctw", paragraph_id: "paragraph-1", segment_order: 1, segment_type: "blank", text_content: null, slot_id: "slot-1" },
      { question_id: "question-ctw", paragraph_id: "paragraph-1", segment_order: 2, segment_type: "blank", text_content: null, slot_id: "slot-2" }
    ],
    item: { logical_item_id: "reading-ctw-item", module: "ctw", title: "CTW" },
    questions: [{ question_id: "question-ctw", question_order: 1, question_type: "ctw" }],
    slots: [
      { question_id: "question-ctw", slot_id: "slot-1", slot_order: 1, prefix: "" },
      { question_id: "question-ctw", slot_id: "slot-2", slot_order: 2, prefix: "" }
    ]
  }), /READING_RESULT_CTW_SEGMENT_MISSING/);

  // The correction result route opts into the tolerant mapping.
  assert.match(
    read("app/api/reading/wrongbook-attempts/[attemptId]/result/route.ts"),
    /tolerateMissingCtwAnswers: true/
  );
});

test("4. the correction review restores missing CTW slots as empty only when tolerated", () => {
  const practice = {
    item: {
      itemId: "reading-ctw-item",
      module: "ctw",
      questionCount: 1,
      scoringPointCount: 2,
      title: "CTW"
    },
    questions: [{
      questionId: "question-ctw",
      questionType: "ctw",
      slots: [
        { slotId: "slot-1", slotOrder: 1, prefix: "", missingLength: 2, displayText: "__" },
        { slotId: "slot-2", slotOrder: 2, prefix: "", missingLength: 2, displayText: "__" }
      ]
    }]
  };
  const rows = [{
    answer_kind: "ctw_slot",
    attempt_answer_id: "answer-1",
    is_correct: true,
    question_id: "question-ctw",
    slot_id: "slot-1",
    student_answer: "ab"
  }];
  const state = buildSubmittedReadingAnswerState(practice, rows, { tolerateMissingCtwSlots: true });
  assert.deepEqual(state["question-ctw"].slots["slot-2"], ["", ""]);
  assert.throws(
    () => buildSubmittedReadingAnswerState(practice, rows),
    /READING_REVIEW_CTW_ANSWER_MISSING/
  );
  assert.match(
    read("app/api/reading/wrongbook-attempts/[attemptId]/review/route.ts"),
    /tolerateMissingCtwSlots: true/
  );
});

test("4. multi-source session aggregation distinguishes per-source totals and long elapsed time", () => {
  const merged = mergeReadingWrongbookSessionResults([
    {
      group: { logicalItemId: "item-a", targets: [{ questionId: "a1", slotId: "s1" }], title: "A" },
      payload: {
        answers: [
          { answerId: "a1", isAnswered: false, isCorrect: false, order: 1, questionId: "a1", questionTimeSeconds: 0 },
          { answerId: "a2", isAnswered: false, isCorrect: false, order: 4, questionId: "a1", questionTimeSeconds: 0 }
        ],
        attempt: { correctPoints: 0, elapsedSeconds: 3600, totalPoints: 1 }
      }
    },
    {
      group: { logicalItemId: "item-b", targets: [{ questionId: "b1", slotId: null }], title: "B" },
      payload: {
        answers: [
          { answerId: "b1", isAnswered: true, isCorrect: true, order: 1, questionId: "b1", questionTimeSeconds: 5 }
        ],
        attempt: { correctPoints: 1, elapsedSeconds: 1800, totalPoints: 1 }
      }
    }
  ]);
  assert.equal(merged.answers.length, 3);
  assert.deepEqual(merged.answers.map((answer) => answer.reviewIndex), [0, 1, 2]);
  assert.equal(merged.correctPoints, 1);
  assert.equal(merged.totalPoints, 2);
  assert.equal(merged.elapsedSeconds, 5400);
});

test("4. the session result distinguishes unfinished, failed, and unaggregatable sources", () => {
  const result = read("components/reading/ReadingWrongbookSessionResult.tsx");
  assert.match(result, /第 \$\{group\.title\} 篇材料尚未提交，暂时无法显示完整结果。/);
  assert.match(result, /篇材料结果加载失败：|篇材料结果暂时无法加载，请稍后重试。/);
  assert.match(result, /练习结果数据暂时无法聚合，请稍后重试。/);
  assert.match(result, /reason: "source-not-completed"/);
  assert.match(result, /reason: payload\.error \?\? "invalid-payload"/);
  // No production record is ever created from the result surface.
  assert.doesNotMatch(result, /method: "POST"/);
  const review = read("components/reading/ReadingWrongbookSessionReview.tsx");
  assert.doesNotMatch(review, /method: "POST"/);
});

// ---------------------------------------------------------------------------
// 5. Review page: current-source-first loading with exact global positions
// ---------------------------------------------------------------------------

const shapeContext = {
  rdl: {
    groups: [
      { logicalItemId: "item-a", targets: [{ questionId: "a1", slotId: null }], title: "A" },
      { logicalItemId: "item-b", targets: [{ questionId: "b1", slotId: null }, { questionId: "b2", slotId: null }], title: "B" },
      { logicalItemId: "item-c", targets: [{ questionId: "c1", slotId: null }], title: "C" }
    ],
    taskType: "rdl"
  },
  ctw: {
    groups: [
      { logicalItemId: "item-a", targets: [{ questionId: "a1", slotId: "s1" }], title: "A" },
      { logicalItemId: "item-b", targets: [{ questionId: "b1", slotId: "s1" }], title: "B" }
    ],
    taskType: "ctw"
  }
};

test("5. RDL / RAP source counts come from the manifest; CTW needs the result-page shape", () => {
  const readingShape = resolveReadingWrongbookSessionReviewShape({
    cachedShape: null,
    groups: shapeContext.rdl.groups,
    taskType: "rdl"
  });
  assert.deepEqual(readingShape, [
    { logicalItemId: "item-a", itemCount: 1 },
    { logicalItemId: "item-b", itemCount: 2 },
    { logicalItemId: "item-c", itemCount: 1 }
  ]);

  // CTW review items include preserved slots, so targets alone are not exact.
  assert.equal(resolveReadingWrongbookSessionReviewShape({
    cachedShape: null,
    groups: shapeContext.ctw.groups,
    taskType: "ctw"
  }), null);

  const cached = [
    { logicalItemId: "item-a", itemCount: 4 },
    { logicalItemId: "item-b", itemCount: 2 }
  ];
  assert.deepEqual(resolveReadingWrongbookSessionReviewShape({
    cachedShape: cached,
    groups: shapeContext.ctw.groups,
    taskType: "ctw"
  }), cached);

  // A cache missing one session source is not trusted.
  assert.equal(resolveReadingWrongbookSessionReviewShape({
    cachedShape: [cached[0]],
    groups: shapeContext.ctw.groups,
    taskType: "ctw"
  }), null);
});

test("5. the opened question resolves to its owning source", () => {
  const shape = [
    { logicalItemId: "item-a", itemCount: 1 },
    { logicalItemId: "item-b", itemCount: 2 },
    { logicalItemId: "item-c", itemCount: 1 }
  ];
  assert.equal(findReadingWrongbookSessionShapeIndex(shape, 0), 0);
  assert.equal(findReadingWrongbookSessionShapeIndex(shape, 1), 1);
  assert.equal(findReadingWrongbookSessionShapeIndex(shape, 2), 1);
  assert.equal(findReadingWrongbookSessionShapeIndex(shape, 3), 2);
  assert.equal(findReadingWrongbookSessionShapeIndex(shape, 99), 2);
});

test("5. placeholder items reserve exact global positions until a source loads", () => {
  const groupReviews = [{
    group: shapeContext.rdl.groups[1],
    payload: {
      answers: {},
      attempt: { attemptId: "attempt-b" },
      disclosures: { "answer-b1": { correctAnswer: { kind: "text", text: "B" }, studentAnswer: "" } },
      practice: { item: { itemId: "item-b", module: "rdl", title: "B" }, questions: [] },
      reviewItems: [
        { answerId: "answer-b1", order: 1, isAnswered: true, isCorrect: false, questionId: "b1", slotId: null, questionTimeSeconds: 4 },
        { answerId: "answer-b2", order: 2, isAnswered: true, isCorrect: true, questionId: "b2", slotId: null, questionTimeSeconds: 3 }
      ]
    }
  }];
  const payload = buildReadingWrongbookSessionReviewPayload({
    groupReviews,
    reviewHref: (globalIndex) => `/student/wrong-questions/sessions/s1/questions/${globalIndex}`,
    sessionId: "s1",
    shapes: [
      { logicalItemId: "item-a", itemCount: 1 },
      { logicalItemId: "item-b", itemCount: 2 },
      { logicalItemId: "item-c", itemCount: 1 }
    ],
    taskType: "rdl",
    title: "历史错题练习"
  });

  assert.equal(payload.reviewItems.length, 4);
  assert.deepEqual(payload.reviewItems.map((item) => [item.order, item.placeholder === true]), [
    [1, true], [2, false], [3, false], [4, true]
  ]);
  assert.deepEqual(payload.reviewItems.map((item) => item.href), [
    "/student/wrong-questions/sessions/s1/questions/0",
    "/student/wrong-questions/sessions/s1/questions/1",
    "/student/wrong-questions/sessions/s1/questions/2",
    "/student/wrong-questions/sessions/s1/questions/3"
  ]);
  // Loaded sources contribute their occurrence; placeholders never do.
  assert.deepEqual(payload.occurrences.map((occurrence) => occurrence.occurrenceId), ["item-b"]);

  // Cross-source navigation still steps over the exact global positions.
  const keys = payload.reviewItems.map((item) => `${item.occurrenceId}:${item.questionId}`);
  assert.equal(readingQuestionNavigationTargets(keys, 0).nextIndex, 1);
  assert.equal(readingQuestionNavigationTargets(keys, 1).previousIndex, 0);
});

test("5. the review loads the opened source first, prefetches neighbours, and defers the rest", () => {
  const review = read("components/reading/ReadingWrongbookSessionReview.tsx");
  assert.match(review, /const groupIndex = findReadingWrongbookSessionShapeIndex\(shape, initialReviewIndex\);/);
  assert.match(review, /shape\[groupIndex\],\n\s+shape\[groupIndex - 1\],\n\s+shape\[groupIndex \+ 1\]/);
  assert.match(review, /for \(const entry of requested\) \{\n\s+if \(entry\) void loadGroup\(entry\.logicalItemId\);/);
  // On-demand loading for every other source plus per-source retry.
  assert.match(review, /onRequestItem=\{\(item, options\) => \{\n\s+void loadGroup\(item\.occurrenceId, options\?\.retry === true\);/);
  // Per-source failures never blank the session.
  assert.match(review, /sourceStatus\[group\.logicalItemId\] = "error"/);
  // The manifest is reused from the result page cache instead of refetched.
  assert.match(review, /studentWrongQuestionsCacheKey\(`reading-bank-result:\$\{sessionId\}`\)/);
  assert.match(review, /useStudentCachedValue<ReadingWrongbookSessionReviewShape\[\]>/);
  // A loaded source review is immutable and reused from cache on later entries.
  assert.match(review, /studentWrongQuestionsCacheKey\(`reading-bank-review:\$\{progress\.attemptId\}`\)/);
  assert.match(review, /cacheRef\.current\.load<ReviewPayload>/);

  const result = read("components/reading/ReadingWrongbookSessionResult.tsx");
  assert.match(result, /readingWrongbookSessionShapeCacheKey\(sessionId\)/);
  assert.match(result, /itemCount: Array\.isArray\(payload\.answers\) \? payload\.answers\.length : 0/);

  // The shell shows a local pending panel for a not-yet-loaded source and can
  // request it automatically when it becomes current.
  const shell = read("components/reading/ReadingPractice.tsx");
  assert.match(shell, /data-testid="reading-session-review-source-pending"/);
  assert.match(shell, /if \(!currentItemPlaceholder \|\| !currentItemOccurrenceId\) return;/);
  assert.match(shell, /onClick=\{\(\) => onRequestItem\?\.\(currentItem, \{ retry: true \}\)\}/);
});

test("5. the shape cache only exists inside the student wrong-question namespace", () => {
  const { readingWrongbookSessionShapeCacheKey } = require("../lib/reading/wrongbookSession.ts");
  assert.equal(
    readingWrongbookSessionShapeCacheKey("session-1"),
    "reading-bank-result-shape:session-1"
  );
});

// ---------------------------------------------------------------------------
// 6. Immersive read-only layout for every Reading task type
// ---------------------------------------------------------------------------

test("6. the session review route uses the immersive shell without the sidebar", () => {
  const shell = read("components/student/StudentShell.tsx");
  assert.match(
    shell,
    /\/\^\\\/student\\\/wrong-questions\\\/sessions\\\/\[\^\/\]\+\\\/questions\\\/\[\^\/\]\+\//
  );
  // Matches the real review path shape.
  assert.match(
    "/student/wrong-questions/sessions/11111111-1111-4111-8111-111111111111/questions/3",
    /^\/student\/wrong-questions\/sessions\/[^/]+\/questions\/[^/]+/
  );

  const review = read("components/reading/ReadingWrongbookSessionReview.tsx");
  // No StudentPage / StudentNavigation wrapper: the reading shell owns layout.
  assert.doesNotMatch(review, /StudentPage/);
  assert.doesNotMatch(review, /StudentNavigation/);
  assert.match(review, /<ReadingFullSetReviewShell/);
  const practiceShell = read("components/reading/ReadingPractice.tsx");
  assert.match(practiceShell, /className="reading-theme min-h-\[100dvh\] bg-\[#fbfbfe\] text-student-text"/);
});

// ---------------------------------------------------------------------------
// 7. Breadcrumbs derived from the validated returnTo chain
// ---------------------------------------------------------------------------

function crumbLabels(navigation) {
  return navigation.crumbs.map((crumb) => crumb.label);
}

test("7. a single-item practice result origin returns to the task catalog", () => {
  const navigation = getReadingCorrectionResultNavigation(
    "/student/reading/results/11111111-1111-4111-8111-111111111111",
    "rap"
  );
  assert.equal(navigation.backHref, "/student/reading/rap");
  assert.deepEqual(crumbLabels(navigation), [
    "学生首页", "Read an Academic Passage", "订正结果"
  ]);
  assert.equal(navigation.crumbs[1].href, "/student/reading/rap");
  assert.equal(navigation.crumbs[2].href, undefined);
  assert.equal(navigation.crumbs.some((crumb) => crumb.label === "错题集"), false);
});

test("7. a single-item practice read-only review origin returns to the task catalog", () => {
  const origin = "/student/reading/results/11111111-1111-4111-8111-111111111111/questions/3";
  const navigation = getReadingCorrectionResultNavigation(origin, "rdl");
  assert.equal(navigation.backHref, "/student/reading/rdl");
  assert.deepEqual(crumbLabels(navigation), [
    "学生首页", "Read in Daily Life", "订正结果"
  ]);
  assert.equal(navigation.crumbs.some((crumb) => crumb.label === "错题集"), false);
});

test("7. a practice-history Reading result origin also returns to the task catalog", () => {
  const origin = "/student/reading/results/22222222-2222-4222-8222-222222222222?source=practice-history";
  const navigation = getReadingCorrectionResultNavigation(origin, "ctw");
  assert.equal(navigation.backHref, "/student/reading/ctw");
  assert.deepEqual(crumbLabels(navigation), [
    "学生首页", "Complete the Words", "订正结果"
  ]);
  assert.equal(navigation.crumbs[1].href, "/student/reading/ctw");
});

test("7. a Full Set result origin keeps the Full Set chain", () => {
  const origin = "/student/reading/full-sets/set-1/result/33333333-3333-4333-8333-333333333333";
  const navigation = getReadingCorrectionResultNavigation(origin, "full_set");
  assert.equal(navigation.backHref, origin);
  assert.deepEqual(crumbLabels(navigation), [
    "学生首页", "Full Set Practice", "查看结果", "订正结果"
  ]);
  assert.equal(navigation.crumbs[1].href, "/student/reading/full-sets");
});

test("7. wrong-question bank origins keep the 错题集 breadcrumb", () => {
  for (const origin of [
    "/student/wrong-questions",
    "/student/wrong-questions/sessions/44444444-4444-4444-8444-444444444444",
    "/student/reading/wrongbook-results/55555555-5555-4555-8555-555555555555"
  ]) {
    const navigation = getReadingCorrectionResultNavigation(origin, "rdl");
    assert.equal(navigation.backHref, origin);
    assert.deepEqual(crumbLabels(navigation), ["学生首页", "错题集", "订正结果"]);
    assert.equal(navigation.crumbs[1].href, "/student/wrong-questions");
  }
});

test("7. nested returnTo chains are decoded and validated level by level", () => {
  const root = "/student/reading/results/66666666-6666-4666-8666-666666666666?source=practice-history";
  const review = withStudentReturnTo(
    "/student/reading/wrongbook-results/77777777-7777-4777-8777-777777777777/questions/0",
    root
  );
  const navigation = getReadingCorrectionResultNavigation(review, "rap");
  // The chain still resolves through the nested review link to the practice
  // surface, so the correction result returns to the task catalog.
  assert.equal(navigation.backHref, "/student/reading/rap");
  assert.deepEqual(crumbLabels(navigation), [
    "学生首页", "Read an Academic Passage", "订正结果"
  ]);
  // The refinement survives a real URL round trip (refresh-safe).
  const parsed = new URL(review, "https://tps.local");
  assert.equal(safeStudentReturnTo(parsed.searchParams.get("returnTo")), root);

  // A review link without an embedded origin falls back to the bank chain.
  const orphanReview = "/student/reading/wrongbook-results/77777777-7777-4777-8777-777777777777/questions/0";
  assert.deepEqual(
    crumbLabels(getReadingCorrectionResultNavigation(orphanReview, "rap")),
    ["学生首页", "错题集", "订正结果"]
  );

  // Unvalidated / external targets can never influence the derived chain.
  for (const unsafe of [
    "https://evil.example/student/reading/results/x",
    "//evil.example/student/reading/results/x",
    "/teacher/reading/results/x",
    undefined
  ]) {
    const fallback = getReadingCorrectionResultNavigation(unsafe, "rap");
    assert.equal(fallback.backHref, "/student/wrong-questions");
    assert.deepEqual(crumbLabels(fallback), ["学生首页", "错题集", "订正结果"]);
  }
});

test("7. ordinary Reading and BAS results also derive their parent chain from returnTo", () => {
  const readingNavigation = getReadingResultNavigation(
    "rap",
    undefined,
    "/student/reading/results/88888888-8888-4888-8888-888888888888"
  );
  assert.deepEqual(crumbLabels(readingNavigation), [
    "学生首页", "Read an Academic Passage", "查看结果", "练习结果"
  ]);
  assert.equal(readingNavigation.crumbs[1].href, "/student/reading/rap");
  assert.equal(readingNavigation.crumbs[2].href, "/student/reading/results/88888888-8888-4888-8888-888888888888");

  const basNavigation = getStudentResultNavigation("202608-0818-1", {
    returnTo: "/student/results/99999999-9999-4999-8999-999999999999"
  });
  assert.deepEqual(crumbLabels(basNavigation), [
    "学生首页", "套题练习", "查看结果", "练习结果"
  ]);
  assert.equal(basNavigation.backHref, "/student/results/99999999-9999-4999-8999-999999999999");

  // A BAS entry correction (virtual wrongbook set) returns to the BAS catalog.
  const basCorrection = getStudentResultNavigation("wrongbook-random-20260930-120000", {
    returnTo: "/student/results/99999999-9999-4999-8999-999999999999"
  });
  assert.deepEqual(crumbLabels(basCorrection), ["学生首页", "套题练习", "练习结果"]);
  assert.equal(basCorrection.backHref, "/student/practice-sets");

  // Assignment origins keep the 我的作业 chain unchanged.
  const assignmentNavigation = getStudentResultNavigation("202608-0818-1", {
    returnTo: "/student/assignments/assignment-1"
  });
  assert.deepEqual(crumbLabels(assignmentNavigation), ["学生首页", "我的作业", "练习结果"]);
  assert.equal(assignmentNavigation.backHref, "/student/assignments/assignment-1");
});

// ---------------------------------------------------------------------------
// 9. CTW context fill: untargeted slots show the correct word, targets stay empty
// ---------------------------------------------------------------------------

test("9. CTW initial answers prefer the student's preserved answer, then the context answer", () => {
  const practice = {
    item: { itemId: "reading-ctw-item", module: "ctw", questionCount: 1, scoringPointCount: 4, title: "CTW" },
    questions: [{
      questionId: "ctw-q",
      questionType: "ctw",
      slots: [
        { slotId: "slot-01", slotOrder: 1, prefix: "", missingLength: 5, displayText: "_____" },
        { slotId: "slot-02", slotOrder: 2, prefix: "", missingLength: 3, displayText: "___" },
        { slotId: "slot-03", slotOrder: 3, prefix: "", missingLength: 4, displayText: "____" },
        { slotId: "slot-04", slotOrder: 4, prefix: "", missingLength: 2, displayText: "__" }
      ]
    }]
  };
  const answers = buildReadingWrongbookInitialAnswers(
    practice,
    [{ answerKind: "ctw_slot", isCorrect: true, questionId: "ctw-q", slotId: "slot-01", studentAnswer: "fir" }],
    [
      { questionId: "ctw-q", slotId: "slot-01", text: "first" },
      { questionId: "ctw-q", slotId: "slot-03", text: "word" }
    ]
  );
  assert.deepEqual(answers["ctw-q"].slots, {
    // The student's own preserved correct text wins over the context text.
    "slot-01": ["f", "i", "r", "", ""],
    // A drawn target never receives context from the server and starts empty.
    "slot-02": ["", "", ""],
    // Untargeted slots show the material's correct word as read-only context.
    "slot-03": ["w", "o", "r", "d"],
    // Untargeted slots without an answer row stay empty (defensive).
    "slot-04": ["", ""]
  });
});

test("9. the context loader returns only untargeted CTW slot answers", () => {
  const server = read("lib/reading/wrongbook.server.ts");
  assert.match(server, /export async function loadReadingCtwContextAnswers/);
  assert.match(server, /\.from\("reading_ctw_slots"\)[\s\S]*missing_text/);
  assert.match(server, /\.filter\(\(slot\) => !targetKeys\.has\(readingWrongbookTargetKey\(/);

  const route = read("app/api/reading/wrongbook-attempts/route.ts");
  // Only the history *session* practice draws a partial slot set: today
  // practice and every entry correction keep their original presentation.
  assert.match(
    route,
    /data\.taskType === "ctw"\n\s+&& bankRequest\.kind === "session"\n\s+&& data\.scope === "history"/
  );
  assert.match(route, /\{ attempt: data, item, preservedAnswers, contextAnswers \}/);

  const bank = read("components/reading/ReadingWrongbookBankPractice.tsx");
  assert.match(bank, /contextAnswers: payload\.contextAnswers \?\? \[\]/);
  assert.match(bank, /attemptState\.data\?\.contextAnswers \?\? \[\]/);
  assert.match(bank, /entryUnit\.contextAnswers/);
});

test("9. entry corrections are only offered from a single-item practice result and its read-only review", () => {
  const readingResult = read("components/reading/ReadingResult.tsx");
  assert.match(readingResult, /ReadingCorrectionEntryButton/);
  const shell = read("components/reading/ReadingPractice.tsx");
  assert.match(shell, /<ReadingCorrectionEntryButton[\s\S]*taskType=\{review\.attempt\.taskType\}/);

  // Correction result / correction review / history-today session review no
  // longer offer the entry button.
  assert.doesNotMatch(read("components/reading/ReadingWrongbookResult.tsx"), /ReadingCorrectionEntryButton/);
  assert.doesNotMatch(read("components/reading/ReadingWrongbookReview.tsx"), /ReadingCorrectionEntryButton/);
  assert.doesNotMatch(
    read("components/reading/ReadingWrongbookSessionReview.tsx"),
    /ReadingCorrectionEntryButton|correctionReturnTo/
  );
});

test("9. context-filled untargeted slots reuse the shared paragraph renderer as read-only text", () => {
  const shell = read("components/reading/ReadingPractice.tsx");
  // Untargeted slots stay non-interactive while their filled characters render
  // through the same blank renderer (no second, context-only code path).
  assert.match(shell, /readOnly=\{readOnly \|\| Boolean\(editableSlotIds && !editableSlotIds\.has\(slot\.slotId\)\)\}/);
  assert.match(shell, /data-ctw-fill-region="true"/);
  assert.match(shell, /data-filled=\{character \? "true" : "false"\}/);
  assert.match(shell, /\{character \|\| null\}/);
  assert.doesNotMatch(shell, /contextAnswer/);
});

// ---------------------------------------------------------------------------
// 10. The review keeps exactly the session's question numbers
// ---------------------------------------------------------------------------

test("10. the correction review lists exactly the attempt targets, never the material's other slots", () => {
  const practice = {
    item: { itemId: "reading-ctw-item", module: "ctw", questionCount: 1, scoringPointCount: 4, title: "CTW" },
    questions: [{
      questionId: "ctw-q",
      questionType: "ctw",
      slots: [
        { slotId: "slot-01", slotOrder: 1, prefix: "", missingLength: 5, displayText: "_____" },
        { slotId: "slot-02", slotOrder: 2, prefix: "", missingLength: 3, displayText: "___" },
        { slotId: "slot-03", slotOrder: 3, prefix: "", missingLength: 4, displayText: "____" },
        { slotId: "slot-04", slotOrder: 4, prefix: "", missingLength: 2, displayText: "__" }
      ]
    }]
  };
  const correctionRows = [
    {
      answer_kind: "ctw_slot",
      attempt_answer_id: "attempt-answer-03",
      is_correct: false,
      question_id: "ctw-q",
      question_time_seconds: 6,
      slot_id: "slot-03",
      student_answer: null
    },
    {
      answer_kind: "ctw_slot",
      attempt_answer_id: "attempt-answer-01",
      is_correct: true,
      question_id: "ctw-q",
      question_time_seconds: 2,
      slot_id: "slot-01",
      student_answer: "first"
    }
  ];
  const reviewItems = buildSubmittedReadingReviewItems(practice, correctionRows);
  // Exactly the two drawn targets, in slot order — never slots 02/04.
  assert.deepEqual(reviewItems.map((item) => item.slotId), ["slot-01", "slot-03"]);
  assert.deepEqual(reviewItems.map((item) => item.order), [1, 3]);

  // Preserved rows still fill the rendered paragraph as read-only context; the
  // route simply never turns them into question numbers.
  const answers = buildSubmittedReadingAnswerState(
    practice,
    [
      ...correctionRows,
      {
        answer_kind: "ctw_slot",
        attempt_answer_id: "preserved-02",
        is_correct: true,
        question_id: "ctw-q",
        slot_id: "slot-02",
        student_answer: "two"
      }
    ],
    { tolerateMissingCtwSlots: true }
  );
  assert.deepEqual(answers["ctw-q"].slots["slot-02"], ["t", "w", "o"]);

  const route = read("app/api/reading/wrongbook-attempts/[attemptId]/review/route.ts");
  assert.match(route, /const reviewItems = buildSubmittedReadingReviewItems\(practice, correctionRows\)/);
  assert.match(route, /const rows = \[\.\.\.correctionRows, \.\.\.preservedAnswers\]/);
});

// ---------------------------------------------------------------------------
// 11. The drawn set is frozen and never redrawn when resuming a session
// ---------------------------------------------------------------------------

test("11. a chooser entry always creates a fresh session; only the pinned id resumes", () => {
  const bank = read("components/reading/ReadingWrongbookBankPractice.tsx");
  // A per-mount entry nonce keeps the chooser key unique, so a previously
  // cached (stale) session manifest can never be rendered first.
  assert.match(bank, /const \[entryNonce\] = useState\(\(\) =>/);
  assert.match(bank, /else params\.set\("entry", entryNonce\)/);
  // Refreshing / going back resumes only through the pinned `sessionId` key.
  assert.match(bank, /if \(activeSessionId\) params\.set\("sessionId", activeSessionId\)/);
  assert.match(bank, /url\.searchParams\.set\("session", serverSessionId\)/);

  // The BAS history practice shares the same rule.
  const basPractice = read("components/WrongQuestions.tsx");
  assert.match(basPractice, /const \[entryNonce\] = useState\(\(\) =>/);
  assert.match(basPractice, /activeSessionId \? \{ sessionId: activeSessionId \} : \{ entry: entryNonce \}/);
});

test("11. a retake asks for the smallest valid 5 / 10 / 15 / 20 amount", () => {
  assert.equal(nextWrongQuestionHistoryAmount(8), 10);
  assert.equal(nextWrongQuestionHistoryAmount(1), 5);
  assert.equal(nextWrongQuestionHistoryAmount(5), 5);
  assert.equal(nextWrongQuestionHistoryAmount(10), 10);
  assert.equal(nextWrongQuestionHistoryAmount(15), 15);
  assert.equal(nextWrongQuestionHistoryAmount(16), 20);
  assert.equal(nextWrongQuestionHistoryAmount(20), 20);

  const result = read("components/reading/ReadingWrongbookSessionResult.tsx");
  assert.match(result, /amount: String\(nextWrongQuestionHistoryAmount\(session\.amount\)\)/);
});

// ---------------------------------------------------------------------------
// 12. Session switching stays local (no new session / redraw on navigation)
// ---------------------------------------------------------------------------

test("12. session-switch state is local-only: no session creation or redraw on navigation", () => {
  const bank = read("components/reading/ReadingWrongbookBankPractice.tsx");
  const navigationBlock = bank.slice(
    bank.indexOf("const handlePreviousSource"),
    bank.indexOf("// A finished session jumps straight back to its result page")
  );
  assert.doesNotMatch(navigationBlock, /fetch\(|createBankSession|readingSessionCreations/);
  assert.match(bank, /if \(!rendered\) \{[\s\S]*ReadingPracticePendingShell/);
  // One shell stays mounted for the whole session; only its workspace swaps.
  assert.match(bank, /const \[rendered, setRendered\] = useState/);
});

// ---------------------------------------------------------------------------
// 13. Session review: paragraph context, instant chip colours, prefetch
// ---------------------------------------------------------------------------

test("13. the review restores the practice's read-only context for untargeted CTW slots", () => {
  const practice = {
    item: { itemId: "reading-ctw-item", module: "ctw", questionCount: 1, scoringPointCount: 4, title: "CTW" },
    questions: [{
      questionId: "ctw-q",
      questionType: "ctw",
      slots: [
        { slotId: "slot-01", slotOrder: 1, prefix: "", missingLength: 5, displayText: "_____" },
        { slotId: "slot-02", slotOrder: 2, prefix: "", missingLength: 3, displayText: "___" },
        { slotId: "slot-03", slotOrder: 3, prefix: "", missingLength: 4, displayText: "____" }
      ]
    }]
  };
  const answers = buildSubmittedReadingAnswerState(
    practice,
    [
      {
        answer_kind: "ctw_slot",
        attempt_answer_id: "attempt-answer-02",
        is_correct: false,
        question_id: "ctw-q",
        slot_id: "slot-02",
        student_answer: null
      },
      {
        answer_kind: "ctw_slot",
        attempt_answer_id: "preserved-01",
        is_correct: true,
        question_id: "ctw-q",
        slot_id: "slot-01",
        student_answer: "first"
      }
    ],
    {
      tolerateMissingCtwSlots: true,
      contextAnswers: [
        { questionId: "ctw-q", slotId: "slot-01", text: "xxxxx" },
        { questionId: "ctw-q", slotId: "slot-03", text: "word" }
      ]
    }
  );
  assert.deepEqual(answers["ctw-q"].slots, {
    // A real row (here the preserved correct answer) always wins over context.
    "slot-01": ["f", "i", "r", "s", "t"],
    "slot-02": ["", "", ""],
    // The untargeted slot shows the material's correct word as context.
    "slot-03": ["w", "o", "r", "d"]
  });

  const route = read("app/api/reading/wrongbook-attempts/[attemptId]/review/route.ts");
  assert.match(route, /const wantsContext = new URL\(request\.url\)\.searchParams\.get\("context"\) === "1"/);
  assert.match(route, /wantsContext && attempt\.task_type === "ctw" && attempt\.scope === "history"/);
  assert.match(route, /tolerateMissingCtwSlots: true,\s*\n\s+contextAnswers/);
  const sessionReview = read("components/reading/ReadingWrongbookSessionReview.tsx");
  assert.match(sessionReview, /\/review\?context=1/);
});

test("13. the result page hands per-item statuses to the review so chips colour immediately", () => {
  const result = read("components/reading/ReadingWrongbookSessionResult.tsx");
  assert.match(result, /items: Array\.isArray\(payload\.answers\)/);
  assert.match(result, /isAnswered: answer\.isAnswered/);
  assert.match(result, /isCorrect: answer\.isCorrect/);

  // Cached shapes are reused (including their statuses) for every task type
  // whose cached count agrees with the drawn targets.
  const cached = [{
    logicalItemId: "item-a",
    itemCount: 1,
    items: [{ isAnswered: true, isCorrect: false, questionTimeSeconds: 5 }]
  }];
  assert.deepEqual(resolveReadingWrongbookSessionReviewShape({
    cachedShape: cached,
    groups: [{ logicalItemId: "item-a", targets: [{ questionId: "a1", slotId: null }], title: "A" }],
    taskType: "rdl"
  }), cached);
  assert.deepEqual(resolveReadingWrongbookSessionReviewShape({
    cachedShape: cached,
    groups: [{ logicalItemId: "item-a", targets: [{ questionId: "a1", slotId: null }, { questionId: "a2", slotId: null }], title: "A" }],
    taskType: "rdl"
  }), [{ logicalItemId: "item-a", itemCount: 2 }]);

  // Placeholder items carry the cached per-item status in exact positions.
  const payload = buildReadingWrongbookSessionReviewPayload({
    groupReviews: [],
    reviewHref: (index) => `/student/wrong-questions/sessions/s1/questions/${index}`,
    sessionId: "s1",
    shapes: [{
      logicalItemId: "item-a",
      itemCount: 2,
      items: [
        { isAnswered: true, isCorrect: true, questionTimeSeconds: 4 },
        { isAnswered: false, isCorrect: false, questionTimeSeconds: null }
      ]
    }],
    taskType: "ctw",
    title: "历史错题练习"
  });
  assert.deepEqual(
    payload.reviewItems.map((item) => [item.isAnswered, item.isCorrect, item.questionTimeSeconds]),
    [[true, true, 4], [false, false, null]]
  );
});

test("13. the session review reuses the practice's cached material and prefetches every source", () => {
  const review = read("components/reading/ReadingWrongbookSessionReview.tsx");
  // Lite review: answers only; the paragraph and assets come from the
  // practice's own cache, so switching never re-downloads material content.
  assert.match(review, /reading-correction-practice:\$\{logicalItemId\}/);
  assert.match(review, /review\?context=1&lite=1/);
  assert.match(review, /selectReadingWrongbookPractice\(cachedPractice, group\.targets\)/);
  assert.match(review, /reviewItems: buildSubmittedReadingReviewItems\(practice, correctionRows\)/);
  // A missing cache (refresh / direct link) falls back to the full review.
  assert.match(review, /return loadGroupReviewFull\(attemptId, session\)/);

  // Every remaining source is prefetched sequentially after the opened one —
  // for every task type, since the lite request carries no material/assets.
  assert.match(review, /if \(!session \|\| !taskType \|\| !shape\?\.length\) return;/);
  assert.match(review, /for \(const logicalItemId of order\) \{\s*\n\s+if \(cancelled\) return;\s*\n\s+await loadGroup\(logicalItemId\);/);
  assert.match(review, /shape\.slice\(groupIndex \+ 1\),\s*\n\s+\.\.\.shape\.slice\(0, groupIndex\)/);
  assert.doesNotMatch(review, /taskType === "rdl"/);

  // The server's lite branch returns only the answer data.
  const route = read("app/api/reading/wrongbook-attempts/[attemptId]/review/route.ts");
  assert.match(route, /const lite = new URL\(request\.url\)\.searchParams\.get\("lite"\) === "1"/);
  assert.match(route, /if \(lite\) \{/);
  assert.match(route, /correctionRows,/);
  assert.match(route, /preservedRows: preservedAnswers/);
  assert.match(route, /disclosures: await loadReadingAnswerDisclosures\(db, rows\)/);
  const liteBlock = route.slice(route.indexOf("if (lite) {"), route.indexOf("let fullPractice"));
  assert.doesNotMatch(liteBlock, /loadStudentReadingPractice/);
});

test("13. lite composition rebuilds the same review payload from the cached practice", () => {
  const fullPractice = {
    item: { itemId: "reading-ctw-item", module: "ctw", questionCount: 1, scoringPointCount: 3, title: "CTW" },
    questions: [{
      questionId: "ctw-q",
      questionType: "ctw",
      slots: [
        { slotId: "slot-01", slotOrder: 1, prefix: "", missingLength: 5, displayText: "_____" },
        { slotId: "slot-02", slotOrder: 2, prefix: "", missingLength: 3, displayText: "___" },
        { slotId: "slot-03", slotOrder: 3, prefix: "", missingLength: 4, displayText: "____" }
      ]
    }]
  };
  const targets = [
    { questionId: "ctw-q", slotId: "slot-02" },
    { questionId: "ctw-q", slotId: "slot-03" }
  ];
  const correctionRows = [
    { answer_kind: "ctw_slot", attempt_answer_id: "answer-02", is_correct: false, question_id: "ctw-q", question_time_seconds: 3, slot_id: "slot-02", student_answer: null },
    { answer_kind: "ctw_slot", attempt_answer_id: "answer-03", is_correct: true, question_id: "ctw-q", question_time_seconds: 2, slot_id: "slot-03", student_answer: "word" }
  ];
  const preservedRows = [
    { answer_kind: "ctw_slot", attempt_answer_id: "preserved-01", is_correct: true, question_id: "ctw-q", slot_id: "slot-01", student_answer: "first" }
  ];
  const contextAnswers = [{ questionId: "ctw-q", slotId: "slot-01", text: "xxxxx" }];

  // The client's lite path composes from the practice cache with the very same
  // helpers the server uses for the full payload.
  const practice = selectReadingWrongbookPractice(fullPractice, targets);
  const reviewItems = buildSubmittedReadingReviewItems(practice, correctionRows);
  const answers = buildSubmittedReadingAnswerState(
    practice,
    [...correctionRows, ...preservedRows],
    { tolerateMissingCtwSlots: true, contextAnswers }
  );

  // Items stay exactly the drawn targets; the paragraph keeps preserved rows
  // and the context fill, and target blanks stay empty.
  assert.deepEqual(reviewItems.map((item) => item.slotId), ["slot-02", "slot-03"]);
  assert.deepEqual(answers["ctw-q"].slots, {
    "slot-01": ["f", "i", "r", "s", "t"],
    "slot-02": ["", "", ""],
    "slot-03": ["w", "o", "r", "d"]
  });
});

// ---------------------------------------------------------------------------
// 14. A single CTW scoring point never renders as the degenerate range 1–1
// ---------------------------------------------------------------------------

test("14. the CTW progress label keeps a single scoring point out of range form", () => {
  const shell = read("components/reading/ReadingPractice.tsx");
  assert.match(shell, /function readingCtwProgressLabel\(scoringPointCount: number\) \{/);
  assert.match(shell, /return count === 1 \? "Question 1 \/ 1" : `Questions 1–\$\{count\} \/ \$\{count\}`;/);
  // Both the practice shell and the pending preview use it.
  assert.match(shell, /readingCtwProgressLabel\(navigation\.scoringPointCount\)/);
  assert.match(shell, /readingCtwProgressLabel\(practice\.item\.scoringPointCount\)/);
  assert.doesNotMatch(shell, /Questions 1–\$\{navigation\.scoringPointCount\} \/ \$\{navigation\.scoringPointCount\}/);
  assert.doesNotMatch(shell, /Questions 1–\$\{practice\.item\.scoringPointCount\} \/ \$\{practice\.item\.scoringPointCount\}/);
});

// ---------------------------------------------------------------------------
// 15. The read-only review header counts questions, never slot numbers
// ---------------------------------------------------------------------------

test("15. the read-only review header counts drawn questions, not slot numbers", () => {
  const shell = read("components/reading/ReadingPractice.tsx");
  // A two-target correction must read 1/2, 2/2 — `order` is the material's
  // question / slot number and only labels the chips.
  assert.match(shell, /Question \$\{reviewIndex \+ 1\} \/ \$\{reviewItems\.length\}/);
  assert.doesNotMatch(shell, /Question \$\{currentReviewItem\.order\} \/ \$\{reviewItems\.length\}/);
  // The chips keep their own numbering.
  assert.match(shell, /\{item\.order\}/);
});

// ---------------------------------------------------------------------------
// 16. An unfinished session resumes as the same session
// ---------------------------------------------------------------------------

test("16. an unfinished session resumes as the same frozen session", () => {
  const history = readingWrongbookSessionResumeHref({
    amount: 8,
    mode: "history",
    returnTo: "/student/wrong-questions",
    sessionId: "session-1",
    taskType: "ctw"
  });
  assert.equal(
    history,
    "/student/wrong-questions/history/reading/practice?session=session-1&taskType=ctw&mode=history&amount=8&returnTo=%2Fstudent%2Fwrong-questions"
  );
  const today = readingWrongbookSessionResumeHref({
    mode: "today",
    returnTo: null,
    sessionId: "session-2",
    taskType: "rap"
  });
  assert.equal(
    today,
    "/student/wrong-questions/today/reading/practice?session=session-2&taskType=rap"
  );

  // The result page turns the dead-end message into 继续练习 back into the SAME
  // session, and the review page never renders a partial (single-material)
  // review for an unfinished session.
  const result = read("components/reading/ReadingWrongbookSessionResult.tsx");
  assert.match(result, /readingWrongbookSessionResumeHref\(\{/);
  assert.match(result, /继续练习/);
  assert.match(result, /这次练习还没有完成/);
  assert.doesNotMatch(result, /这次练习还没有完成，请回到练习继续作答。/);
  const review = read("components/reading/ReadingWrongbookSessionReview.tsx");
  assert.match(
    review,
    /\(session\.groups \?\? \[\]\)\.some\(\(group\) => !session\.progress\?\.\[group\.logicalItemId\]\)/
  );
  assert.match(review, /description="这次练习还没有完成。"/);
});
