const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createHistoricalPracticeDisplayResolver,
  enrichBuildSentenceHistoricalAttempts,
  loadWritingAssignmentDisplayNames
} = require("../lib/historicalPracticeDisplay.ts");
const { buildPracticeHistoryPayload } = require("../lib/practiceHistory.ts");
const { buildWritingSubmissionHistory } = require("../lib/writingSubmissionHistory.ts");

const projectRoot = path.resolve(__dirname, "..");

function item(itemId, taskType, displayNumber, displayTitle = null, isActive = true) {
  return {
    item_id: itemId,
    task_type: taskType,
    display_number: displayNumber,
    display_title: displayTitle,
    is_active: isActive
  };
}

function source(sourceId, itemId, taskType, rawId) {
  return {
    source_id: sourceId,
    item_id: itemId,
    task_type: taskType,
    source_set_id: taskType === "build_sentence" ? rawId : null,
    source_question_id: taskType === "build_sentence" ? null : rawId
  };
}

function resolver(displayNumber = "057B") {
  return createHistoricalPracticeDisplayResolver({
    items: [
      item("bas-item", "build_sentence", displayNumber),
      item("email-item", "email", "021", "Request for Schedule Change"),
      item("ad-item", "academic_discussion", "018", "Nature vs Nurture"),
      item("inactive-item", "email", "022", "Archived Prompt", false)
    ],
    sources: [
      source("bas-a", "bas-item", "build_sentence", "raw-a"),
      source("bas-b", "bas-item", "build_sentence", "raw-b"),
      source("bas-c", "bas-item", "build_sentence", "raw-c"),
      source("email-a", "email-item", "email", "email-a"),
      source("email-b", "email-item", "email", "email-b"),
      source("ad-a", "ad-item", "academic_discussion", "ad-a"),
      source("inactive", "inactive-item", "email", "email-inactive")
    ]
  });
}

function basAttempt(attemptId, setId, submittedAt) {
  return {
    attemptId,
    setId,
    setTitle: `${setId} raw title`,
    correctCount: 1,
    totalQuestions: 1,
    timeSpentSeconds: 10,
    submittedAt
  };
}

test("BAS A/B/C attempts remain three exact histories with the same current logical name", () => {
  const attempts = [
    basAttempt("attempt-a", "raw-a", "2026-05-01T00:00:00Z"),
    basAttempt("attempt-b", "raw-b", "2026-06-01T00:00:00Z"),
    basAttempt("attempt-c", "raw-c", "2026-07-01T00:00:00Z")
  ];
  const enriched = enrichBuildSentenceHistoricalAttempts(attempts, resolver());
  assert.equal(enriched.length, 3);
  assert.deepEqual(enriched.map(({ attemptId }) => attemptId), ["attempt-a", "attempt-b", "attempt-c"]);
  assert.deepEqual(enriched.map(({ setId }) => setId), ["raw-a", "raw-b", "raw-c"]);
  assert.deepEqual(enriched.map(({ setTitle }) => setTitle), ["套题057B", "套题057B", "套题057B"]);
});

test("a display_number correction changes history naming without changing attempt identity", () => {
  const attempts = [basAttempt("attempt-fixed", "raw-a", "2026-05-01T00:00:00Z")];
  assert.equal(enrichBuildSentenceHistoricalAttempts(attempts, resolver("060"))[0].setTitle, "套题060");
  const corrected = enrichBuildSentenceHistoricalAttempts(attempts, resolver("057B"))[0];
  assert.equal(corrected.attemptId, "attempt-fixed");
  assert.equal(corrected.setId, "raw-a");
  assert.equal(corrected.setTitle, "套题057B");
});

test("BAS historical result keeps exact attempt and raw questions while changing only display title", () => {
  const route = fs.readFileSync(path.join(projectRoot, "app/api/attempts/[attemptId]/route.ts"), "utf8");
  assert.match(route, /\.eq\("attempt_id", params\.attemptId\)/);
  assert.match(route, /\.eq\("attempt_id", params\.attemptId\)[\s\S]*\.order\("question_order"/);
  assert.match(route, /set_title: historicalDisplay\.displayName/);
  assert.match(route, /questionById\.get\(String\(answer\.question_id\)\)/);
});

test("Grammar and Wrongbook virtual histories keep their existing names", () => {
  const historicalResolver = resolver();
  const grammar = historicalResolver.resolveBuildSentence({
    fallbackDisplayName: "Grammar Practice · Clauses",
    rawSetId: "grammar-all-clauses"
  });
  const wrongbook = historicalResolver.resolveBuildSentence({
    fallbackDisplayName: "历史错题合集",
    rawSetId: "wrongbook-all-student"
  });
  assert.deepEqual([grammar.displayName, grammar.resolution], ["Grammar Practice · Clauses", "virtual"]);
  assert.deepEqual([wrongbook.displayName, wrongbook.resolution], ["历史错题合集", "virtual"]);
  assert.equal(grammar.warning, null);
  assert.equal(wrongbook.warning, null);
});

test("duplicate raw writing submissions remain independent but share logical display", () => {
  const historicalResolver = resolver();
  const submissions = ["email-a", "email-b"].map((rawQuestionId, index) => ({
    attemptId: `writing-${index + 1}`,
    rawQuestionId,
    display: historicalResolver.resolveWritingAttempt({
      assignmentId: null,
      fallbackDisplayName: `raw ${index + 1}`,
      rawQuestionId,
      taskType: "email"
    })
  }));
  assert.deepEqual(submissions.map(({ attemptId }) => attemptId), ["writing-1", "writing-2"]);
  assert.deepEqual(submissions.map(({ rawQuestionId }) => rawQuestionId), ["email-a", "email-b"]);
  assert.deepEqual(submissions.map(({ display }) => display.displayName), [
    "题目021 Request for Schedule Change",
    "题目021 Request for Schedule Change"
  ]);
});

test("free writing uses logical display while exact historical question content is untouched", () => {
  const exactQuestion = {
    question_id: "email-b",
    set_title: "8.18 raw B",
    subject: "Exact historical B subject"
  };
  const display = resolver().resolveWritingAttempt({
    assignmentId: null,
    fallbackDisplayName: exactQuestion.set_title,
    rawQuestionId: exactQuestion.question_id,
    taskType: "email"
  });
  assert.equal(display.displayName, "题目021 Request for Schedule Change");
  assert.deepEqual(exactQuestion, {
    question_id: "email-b",
    set_title: "8.18 raw B",
    subject: "Exact historical B subject"
  });
});

test("question-bank assignment uses the current logical title instead of the snapshot raw title", () => {
  const display = resolver().resolveWritingAttempt({
    assignmentId: "assignment-1",
    assignmentDisplayName: "Weekly Assignment Snapshot",
    fallbackDisplayName: "raw title",
    questionSource: "question_bank",
    rawQuestionId: "email-a",
    taskType: "email"
  });
  assert.equal(display.resolution, "assignment");
  assert.equal(display.displayName, "题目021 Request for Schedule Change");
  assert.equal(display.logicalDisplayName, "题目021 Request for Schedule Change");
  assert.equal(display.rawQuestionId, "email-a");
});

test("custom assignment has no logical item or number", () => {
  const display = resolver().resolveWritingAttempt({
    assignmentId: "assignment-custom",
    assignmentDisplayName: "Teacher Custom Prompt",
    fallbackDisplayName: "custom raw",
    questionSource: "custom",
    rawQuestionId: "custom:assignment-custom",
    taskType: "email"
  });
  assert.equal(display.displayName, "Teacher Custom Prompt");
  assert.equal(display.logicalDisplayName, null);
  assert.equal(display.itemId, null);
  assert.equal(display.displayNumber, null);
});

test("inactive historical item remains resolvable", () => {
  const display = resolver().resolveWritingAttempt({
    assignmentId: null,
    fallbackDisplayName: "old raw title",
    rawQuestionId: "email-inactive",
    taskType: "email"
  });
  assert.equal(display.displayName, "题目022 Archived Prompt");
  assert.equal(display.isActive, false);
  assert.equal(display.resolution, "logical");
});

test("orphan history shows a neutral title with a structured warning instead of the raw historical title", () => {
  const display = resolver().resolveWritingAttempt({
    assignmentId: null,
    fallbackDisplayName: "orphan raw title",
    rawQuestionId: "orphan-question",
    taskType: "academic_discussion"
  });
  assert.equal(display.displayName, "未命名题目");
  assert.equal(display.resolution, "fallback");
  assert.doesNotMatch(JSON.stringify(display), /orphan raw title/);
  // The raw identity stays in the structured warning for debugging only.
  assert.deepEqual(display.warning, {
    code: "HISTORICAL_SOURCE_NOT_MAPPED",
    taskType: "academic_discussion",
    rawSetId: null,
    rawQuestionId: "orphan-question",
    itemId: null,
    message: "Historical raw source has no practice_item_sources mapping."
  });
});

test("official BAS / WE / AD resolver failures return neutral titles, never the raw historical title", () => {
  const historicalResolver = resolver();
  const bas = historicalResolver.resolveBuildSentence({
    fallbackDisplayName: "9.15 - 3",
    rawSetId: "202609-0915-3"
  });
  assert.equal(bas.displayName, "未编号套题");
  assert.equal(bas.resolution, "fallback");
  assert.equal(bas.warning.code, "HISTORICAL_SOURCE_NOT_MAPPED");
  assert.doesNotMatch(JSON.stringify(bas), /9\.15 - 3/);

  const email = historicalResolver.resolveWritingAttempt({
    assignmentId: null,
    fallbackDisplayName: "1.21-1",
    rawQuestionId: "EMAIL-2099-UNKNOWN",
    taskType: "email"
  });
  assert.equal(email.displayName, "未命名题目");
  assert.equal(email.resolution, "fallback");
  assert.doesNotMatch(JSON.stringify(email), /1\.21-1/);

  const discussion = historicalResolver.resolveWritingAttempt({
    assignmentId: null,
    fallbackDisplayName: "8.26B",
    rawQuestionId: "AD-2099-UNKNOWN",
    taskType: "academic_discussion"
  });
  assert.equal(discussion.displayName, "未命名题目");
  assert.equal(discussion.resolution, "fallback");
  assert.doesNotMatch(JSON.stringify(discussion), /8\.26B/);
});

test("ambiguous / missing-item / missing-number official mappings also stay neutral", () => {
  const ambiguous = createHistoricalPracticeDisplayResolver({
    items: [
      item("email-item-a", "email", "021", "A"),
      item("email-item-b", "email", "022", "B")
    ],
    sources: [
      source("email-a1", "email-item-a", "email", "email-ambiguous"),
      source("email-a2", "email-item-b", "email", "email-ambiguous")
    ]
  }).resolveWritingAttempt({
    assignmentId: null,
    fallbackDisplayName: "1.21-1",
    rawQuestionId: "email-ambiguous",
    taskType: "email"
  });
  assert.equal(ambiguous.displayName, "未命名题目");
  assert.equal(ambiguous.warning.code, "AMBIGUOUS_HISTORICAL_SOURCE");
  assert.doesNotMatch(JSON.stringify(ambiguous), /1\.21-1/);

  const missingItem = createHistoricalPracticeDisplayResolver({
    items: [],
    sources: [source("email-b1", "email-item", "email", "email-missing-item")]
  }).resolveWritingAttempt({
    assignmentId: null,
    fallbackDisplayName: "1.21-1",
    rawQuestionId: "email-missing-item",
    taskType: "email"
  });
  assert.equal(missingItem.displayName, "未命名题目");
  assert.equal(missingItem.warning.code, "HISTORICAL_ITEM_MISSING");
  assert.doesNotMatch(JSON.stringify(missingItem), /1\.21-1/);

  const missingNumber = createHistoricalPracticeDisplayResolver({
    items: [item("email-item", "email", "", "Request for Schedule Change")],
    sources: [source("email-c1", "email-item", "email", "email-missing-number")]
  }).resolveWritingAttempt({
    assignmentId: null,
    fallbackDisplayName: "1.21-1",
    rawQuestionId: "email-missing-number",
    taskType: "email"
  });
  assert.equal(missingNumber.displayName, "未命名题目");
  assert.equal(missingNumber.warning.code, "HISTORICAL_DISPLAY_NUMBER_MISSING");
  assert.doesNotMatch(JSON.stringify(missingNumber), /1\.21-1/);
});

test("an official Assignment mapping failure shows the neutral fallback instead of the snapshot title", () => {
  const display = resolver().resolveWritingAttempt({
    assignmentId: "assignment-orphan",
    assignmentDisplayName: "5.23",
    fallbackDisplayName: "5.23",
    questionSource: "question_bank",
    rawQuestionId: "EMAIL-2099-UNKNOWN",
    taskType: "email"
  });
  assert.equal(display.displayName, "未命名题目");
  assert.equal(display.resolution, "assignment");
  assert.equal(display.logicalDisplayName, null);
  assert.equal(display.warning.code, "HISTORICAL_SOURCE_NOT_MAPPED");
  assert.doesNotMatch(JSON.stringify(display), /5\.23/);
});

test("an official BAS Assignment mapping failure shows 未编号套题 instead of the snapshot title", async () => {
  const calls = [];
  const supabase = fakeSupabase({ practice_item_sources: [] }, calls);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const displayNames = await loadWritingAssignmentDisplayNames(supabase, [{
      assignmentId: "bas-orphan",
      fallbackDisplayName: "9.15 - 3",
      rawQuestionId: "435ff273-f538-42d1-94d6-8d90e9b0a211",
      questionSource: "question_bank",
      sourceSetId: "202609-0915-3",
      taskType: "build_sentence"
    }]);
    assert.equal(displayNames.get("bas-orphan"), "未编号套题");
    assert.doesNotMatch(JSON.stringify([...displayNames.values()]), /9\.15 - 3/);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(calls, ["practice_item_sources"]);
});

test("custom Assignment titles and the persisted snapshot fields stay untouched", async () => {
  const historicalResolver = resolver();
  const snapshot = {
    set_title: "5.23",
    source_labels: "5.23A|5.23B",
    source_set_id: "202609-0915-3"
  };
  const snapshotBefore = structuredClone(snapshot);
  const custom = historicalResolver.resolveWritingAttempt({
    assignmentId: "assignment-custom",
    assignmentDisplayName: snapshot.set_title,
    fallbackDisplayName: "raw custom fallback",
    questionSource: "custom",
    rawQuestionId: "custom:assignment-custom",
    taskType: "email"
  });
  assert.equal(custom.displayName, "5.23");
  assert.equal(custom.resolution, "assignment");
  assert.doesNotMatch(JSON.stringify(custom), /raw custom fallback/);
  assert.deepEqual(snapshot, snapshotBefore);

  // The resolver never mutates the loaded rows either.
  const items = [item("email-item", "email", "021", "Request for Schedule Change")];
  const sources = [source("email-a", "email-item", "email", "email-a")];
  const itemsBefore = structuredClone(items);
  const sourcesBefore = structuredClone(sources);
  const created = createHistoricalPracticeDisplayResolver({ items, sources });
  created.resolveWritingAttempt({
    assignmentId: null,
    fallbackDisplayName: "1.21-1",
    rawQuestionId: "email-a",
    taskType: "email"
  });
  created.resolveBuildSentence({ fallbackDisplayName: "9.15 - 3", rawSetId: "202609-0915-3" });
  assert.deepEqual(items, itemsBefore);
  assert.deepEqual(sources, sourcesBefore);

  // The Assignment display-name loader keeps custom titles and still hands the
  // raw snapshot fields back to its callers unchanged.
  const calls = [];
  const supabase = fakeSupabase({ practice_item_sources: [] }, calls);
  const customInput = {
    assignmentId: "custom-email",
    fallbackDisplayName: "5.23",
    rawQuestionId: "custom:custom-email",
    questionSource: "custom",
    taskType: "email"
  };
  const customInputBefore = structuredClone(customInput);
  const displayNames = await loadWritingAssignmentDisplayNames(supabase, [customInput]);
  assert.equal(displayNames.get("custom-email"), "5.23");
  assert.deepEqual(customInput, customInputBefore);
  assert.deepEqual(calls, []);
});

test("BAS and writing history sorting remains actual attempt/submission time", () => {
  const bas = buildPracticeHistoryPayload({
    attempts: [
      basAttempt("old", "raw-a", "2026-08-01T00:00:00Z"),
      basAttempt("new", "raw-b", "2026-08-03T00:00:00Z")
    ],
    answers: [],
    correctionAnswers: [],
    todayStart: Date.parse("2026-08-10T00:00:00Z"),
    todayEnd: Date.parse("2026-08-11T00:00:00Z")
  });
  assert.deepEqual(bas.attempts.map(({ attemptId }) => attemptId), ["new", "old"]);

  const writing = buildWritingSubmissionHistory([
    { attempt_id: "old", submitted_at: "2026-08-01T00:00:00Z", word_count: 1, writing_mode: "exam", elapsed_seconds: 1 },
    { attempt_id: "new", submitted_at: "2026-08-03T00:00:00Z", word_count: 1, writing_mode: "exam", elapsed_seconds: 1 }
  ], new Set());
  assert.deepEqual(writing.map(({ attempt_id }) => attempt_id), ["new", "old"]);
});

test("history React keys and URLs keep attempt_id rather than display_number", () => {
  const basUi = fs.readFileSync(path.join(projectRoot, "components/AttemptHistoryList.tsx"), "utf8");
  const writingUi = fs.readFileSync(path.join(projectRoot, "components/writing/WritingSubmissionHistory.tsx"), "utf8");
  assert.match(writingUi, /id: attempt\.attempt_id/);
  assert.match(writingUi, /writingSubmissionResultHref\([\s\S]*attempt\.attempt_id/);
  assert.doesNotMatch(writingUi, /key=\{[^}]*display_number/);
  assert.match(basUi, /attemptId/);
});

test("Dashboard and student review UI render only the resolved display_name, never the historical set_title", () => {
  const dashboard = fs.readFileSync(path.join(projectRoot, "components/student/StudentDashboard.tsx"), "utf8");
  const reviewUi = fs.readFileSync(path.join(projectRoot, "components/student/StudentWritingReview.tsx"), "utf8");
  const reviewListUi = reviewUi;
  const reviewRoute = fs.readFileSync(path.join(projectRoot, "app/api/writing/reviews/route.ts"), "utf8");
  assert.match(dashboard, /draft\.displayName/);
  assert.match(reviewListUi, /review\.display_name\}/);
  assert.doesNotMatch(reviewUi, /display_name \?\? [a-zA-Z.]*set_title/);
  assert.match(reviewRoute, /set_title: setTitle/);
  assert.match(reviewRoute, /display_name: display\.displayName/);
  assert.match(reviewRoute, /assignmentDisplayName: setTitle/);
});

test("historical resolver loads items and sources in two batched table reads, not per history row", () => {
  const helper = fs.readFileSync(path.join(projectRoot, "lib/historicalPracticeDisplay.ts"), "utf8");
  assert.match(helper, /Promise\.all\(\[/);
  assert.ok((helper.match(/\.from\("practice_items"\)/g) ?? []).length <= 2);
  assert.ok((helper.match(/\.from\("practice_item_sources"\)/g) ?? []).length <= 3);
  assert.doesNotMatch(helper, /for \([^)]*(attempt|submission)[^)]*\)[\s\S]{0,200}\.from\(/i);
});

function itemWithSource(item, source) {
  return { ...source, item };
}

function fakeSupabase(tables, calls) {
  return {
    from(table) {
      calls.push(table);
      const filters = [];
      const builder = {
        select: () => builder,
        eq: (column, value) => {
          filters.push([column, value]);
          return builder;
        },
        in: (column, values) => {
          filters.push([column, values]);
          return builder;
        },
        order: () => builder,
        range: (from, to) => Promise.resolve({
          data: (tables[table] ?? [])
            .filter((row) => filters.every(([column, value]) =>
              Array.isArray(value) ? value.includes(row[column]) : row[column] === value
            ))
            .slice(from, to + 1),
          error: null
        })
      };
      return builder;
    }
  };
}

test("assignment display names resolve bank titles, keep custom titles, and fall back unmapped", async () => {
  const calls = [];
  const emailItem = item("email-item", "email", "021", "Request for Schedule Change");
  const supabase = fakeSupabase({
    practice_item_sources: [
      itemWithSource(emailItem, {
        source_id: "email-a-source",
        item_id: emailItem.item_id,
        task_type: "email",
        source_set_id: null,
        source_question_id: "email-a"
      })
    ]
  }, calls);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const displayNames = await loadWritingAssignmentDisplayNames(supabase, [
      {
        assignmentId: "bank-email",
        fallbackDisplayName: "8.8A old raw title",
        rawQuestionId: "email-a",
        questionSource: "question_bank",
        taskType: "email"
      },
      {
        assignmentId: "custom-email",
        fallbackDisplayName: "Teacher Custom Prompt",
        rawQuestionId: "custom:custom-email",
        questionSource: "custom",
        taskType: "email"
      },
      {
        assignmentId: "orphan-ad",
        fallbackDisplayName: "Legacy AD Raw Title",
        rawQuestionId: "orphan-ad-raw",
        questionSource: "question_bank",
        taskType: "academic_discussion"
      }
    ]);
    assert.equal(displayNames.get("bank-email"), "题目021 Request for Schedule Change");
    assert.equal(displayNames.get("custom-email"), "Teacher Custom Prompt");
    // An unmapped official row must never surface the stored snapshot / raw
    // historical title; the neutral fallback replaces it.
    assert.equal(displayNames.get("orphan-ad"), "未命名题目");
    assert.doesNotMatch(
      JSON.stringify([...displayNames.values()]),
      /Legacy AD Raw Title|8.8A old raw title/
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(calls, ["practice_item_sources", "practice_item_sources"]);
});

test("BAS assignment display names resolve the current 套题NNN by source set id", async () => {
  const calls = [];
  const basItem = item("bas-item", "build_sentence", "143");
  const supabase = fakeSupabase({
    practice_item_sources: [
      itemWithSource(basItem, {
        source_id: "bas-source",
        item_id: basItem.item_id,
        task_type: "build_sentence",
        source_set_id: "202609-0915-3",
        source_question_id: null
      })
    ],
    practice_items: [basItem]
  }, calls);
  const displayNames = await loadWritingAssignmentDisplayNames(supabase, [{
    assignmentId: "bas-assignment",
    fallbackDisplayName: "9.15 - 3",
    rawQuestionId: "item-uuid",
    questionSource: "question_bank",
    sourceSetId: "202609-0915-3",
    taskType: "build_sentence"
  }]);
  assert.equal(displayNames.get("bas-assignment"), "套题143");
  assert.deepEqual(calls, ["practice_item_sources", "practice_items"]);
});

test("custom-only assignment display loads no practice item mapping table", async () => {  const calls = [];
  const supabase = fakeSupabase({ practice_item_sources: [] }, calls);
  const displayNames = await loadWritingAssignmentDisplayNames(supabase, [
    {
      assignmentId: "custom-only",
      fallbackDisplayName: "Teacher Custom Prompt",
      rawQuestionId: "custom:custom-only",
      questionSource: "custom",
      taskType: "email"
    }
  ]);
  assert.equal(displayNames.get("custom-only"), "Teacher Custom Prompt");
  assert.deepEqual(calls, []);
});

test("assignment display resolver reuses the scoped logical mapping loader instead of full table reads", () => {
  const helper = fs.readFileSync(path.join(projectRoot, "lib/historicalPracticeDisplay.ts"), "utf8");
  const helperBody = helper.slice(
    helper.indexOf("export async function loadWritingAssignmentDisplayNames")
  );
  assert.match(helperBody, /loadWritingHistoricalPracticeDisplayResolver\(/);
  assert.match(helperBody, /Promise\.all\(/);
  assert.match(helperBody, /logHistoricalPracticeDisplayWarnings/);
  assert.doesNotMatch(helperBody, /from\("practice_items"\)|from\("practice_item_sources"\)/);
});
