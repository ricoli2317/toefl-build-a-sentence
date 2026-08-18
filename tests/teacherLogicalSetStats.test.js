const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildTeacherLogicalSetSummaries
} = require("../lib/teacherLogicalSetStats.ts");

const projectRoot = path.resolve(__dirname, "..");

function item({
  itemId = "item-x",
  displayNumber = "057A",
  firstSeenDate = "2026-05-24",
  active = true
} = {}) {
  return {
    item_id: itemId,
    task_type: "build_sentence",
    display_number: displayNumber,
    first_seen_date: firstSeenDate,
    is_active: active
  };
}

function source(sourceId, setId, itemId = "item-x") {
  return {
    source_id: sourceId,
    item_id: itemId,
    task_type: "build_sentence",
    source_set_id: setId
  };
}

function attempt(attemptId, studentId, setId, correctCount = 8, totalQuestions = 10) {
  return {
    attempt_id: attemptId,
    student_id: studentId,
    set_id: setId,
    correct_count: correctCount,
    total_questions: totalQuestions
  };
}

function questions(setId, count = 10) {
  return Array.from({ length: count }, (_, index) => ({
    question_id: `${setId}-q${index + 1}`,
    set_id: setId
  }));
}

function summarize(overrides = {}) {
  return buildTeacherLogicalSetSummaries({
    items: [item()],
    sources: [source("source-a", "set-a")],
    occurrences: [{ source_id: "source-a", occurred_on: "2026-05-24" }],
    attempts: [],
    questions: questions("set-a"),
    ...overrides
  });
}

test("A, B, and C raw sets produce one logical teacher set", () => {
  const sets = summarize({
    sources: [
      source("source-a", "set-a"),
      source("source-b", "set-b"),
      source("source-c", "set-c")
    ],
    occurrences: [
      { source_id: "source-a", occurred_on: "2026-05-24" },
      { source_id: "source-b", occurred_on: "2026-06-15" },
      { source_id: "source-c", occurred_on: "2026-07-14" }
    ],
    questions: [...questions("set-a"), ...questions("set-b"), ...questions("set-c")]
  });

  assert.equal(sets.length, 1);
  assert.equal(sets[0].itemId, "item-x");
  assert.deepEqual(sets[0].sourceSetIds, ["set-a", "set-b", "set-c"]);
  assert.deepEqual(sets[0].occurrenceDates, ["2026-07-14", "2026-06-15", "2026-05-24"]);
  assert.equal(sets[0].questionCount, 10, "duplicate raw sources must not inflate logical question count");
});

test("all 10 + 8 + 12 historical attempts are counted without latest-per-student deduplication", () => {
  const attempts = [
    ...Array.from({ length: 10 }, (_, index) => attempt(`a-${index}`, `student-a-${index}`, "set-a")),
    ...Array.from({ length: 8 }, (_, index) => attempt(`b-${index}`, `student-b-${index}`, "set-b")),
    ...Array.from({ length: 12 }, (_, index) => attempt(`c-${index}`, `student-c-${index}`, "set-c"))
  ];
  const sets = summarize({
    sources: [source("source-a", "set-a"), source("source-b", "set-b"), source("source-c", "set-c")],
    attempts
  });

  assert.equal(sets[0].totalAttemptCount, 30);
});

test("completed student count remains unique across all raw sources", () => {
  const sets = summarize({
    sources: [source("source-a", "set-a"), source("source-b", "set-b"), source("source-c", "set-c")],
    attempts: [
      attempt("attempt-a", "same-student", "set-a"),
      attempt("attempt-b", "same-student", "set-b"),
      attempt("attempt-c", "same-student", "set-c")
    ]
  });

  assert.equal(sets[0].totalAttemptCount, 3);
  assert.equal(sets[0].completedStudentCount, 1);
});

test("average accuracy keeps the existing weighted historical attempt formula", () => {
  const sets = summarize({
    sources: [source("source-a", "set-a"), source("source-b", "set-b"), source("source-c", "set-c")],
    attempts: [
      attempt("attempt-a", "student-a", "set-a", 10, 10),
      attempt("attempt-b", "student-b", "set-b", 0, 10),
      attempt("attempt-c", "student-c", "set-c", 5, 10)
    ]
  });

  assert.equal(sets[0].correctCount, 15);
  assert.equal(sets[0].totalQuestions, 30);
  assert.equal(sets[0].averageAccuracy, 0.5);
});

test("non-canonical A and C attempts remain included when B is canonical", () => {
  const sets = summarize({
    sources: [
      { ...source("source-a", "set-a"), is_canonical: false },
      { ...source("source-b", "set-b"), is_canonical: true },
      { ...source("source-c", "set-c"), is_canonical: false }
    ],
    attempts: [
      attempt("attempt-a", "student-a", "set-a"),
      attempt("attempt-c", "student-c", "set-c")
    ]
  });

  assert.equal(sets[0].totalAttemptCount, 2);
});

test("grammar and wrongbook virtual sources never enter ordinary teacher set statistics", () => {
  const sets = summarize({
    sources: [
      source("source-a", "set-a"),
      source("source-grammar-all", "grammar-all-tense"),
      source("source-grammar-random", "grammar-random-student"),
      source("source-wrongbook", "wrongbook-student")
    ],
    attempts: [
      attempt("official", "student-a", "set-a"),
      attempt("grammar-all", "student-b", "grammar-all-tense"),
      attempt("grammar-random", "student-c", "grammar-random-student"),
      attempt("wrongbook", "student-d", "wrongbook-student")
    ]
  });

  assert.deepEqual(sets[0].sourceSetIds, ["set-a"]);
  assert.equal(sets[0].totalAttemptCount, 1);
});

test("current display number changes the name without changing identity or statistics", () => {
  const shared = {
    sources: [source("source-a", "set-a", "stable-item")],
    attempts: [attempt("attempt-a", "student-a", "set-a", 7, 10)]
  };
  const before = summarize({ ...shared, items: [item({ itemId: "stable-item", displayNumber: "060" })] })[0];
  const after = summarize({ ...shared, items: [item({ itemId: "stable-item", displayNumber: "057B" })] })[0];

  assert.equal(before.itemId, "stable-item");
  assert.equal(after.itemId, "stable-item");
  assert.equal(after.setTitle, "套题057B");
  for (const key of ["totalAttemptCount", "completedStudentCount", "correctCount", "totalQuestions", "averageAccuracy"]) {
    assert.equal(after[key], before[key]);
  }
});

test("sets sort by first_seen_date descending with item_id as a stable same-date tie-break", () => {
  const sets = summarize({
    items: [
      item({ itemId: "item-b", displayNumber: "002", firstSeenDate: "2026-08-01" }),
      item({ itemId: "item-a", displayNumber: "001", firstSeenDate: "2026-08-01" }),
      item({ itemId: "item-new", displayNumber: "003", firstSeenDate: "2026-08-02" })
    ],
    sources: [
      source("source-b", "set-b", "item-b"),
      source("source-a", "set-a", "item-a"),
      source("source-new", "set-new", "item-new")
    ]
  });

  assert.deepEqual(sets.map(({ itemId }) => itemId), ["item-new", "item-a", "item-b"]);
});

test("inactive logical items with historical sources and attempts remain visible", () => {
  const sets = summarize({
    items: [item({ active: false })],
    attempts: [attempt("historical-attempt", "student-a", "set-a")]
  });

  assert.equal(sets.length, 1);
  assert.equal(sets[0].isActive, false);
  assert.equal(sets[0].totalAttemptCount, 1);
});

test("aggregation does not rewrite exact historical attempt_id or raw set_id", () => {
  const attempts = [attempt("exact-attempt-id", "student-a", "historical-raw-set")];
  const snapshot = structuredClone(attempts);
  summarize({
    sources: [source("source-old", "historical-raw-set")],
    attempts
  });

  assert.deepEqual(attempts, snapshot);
});

test("server and UI use batched logical mapping, item identity, and raw drill-down compatibility", () => {
  const route = fs.readFileSync(path.join(projectRoot, "app/api/teacher/stats/route.ts"), "utf8");
  const dashboard = fs.readFileSync(path.join(projectRoot, "components/TeacherDashboard.tsx"), "utf8");

  assert.match(route, /Promise\.all\([\s\S]*practice_items[\s\S]*practice_item_sources/);
  assert.match(route, /buildTeacherLogicalSetSummaries\(\{[\s\S]*attempts:\s*attemptRows/);
  assert.doesNotMatch(route, /for\s*\([^)]*logical[^)]*\)[\s\S]{0,300}\.from\("attempts"\)/i);
  assert.match(dashboard, /href=\{`\/teacher\/sets\/\$\{encodeURIComponent\(set\.itemId\)\}`\}/);
  assert.match(dashboard, /logicalSet\.sourceSetIds\.map/);
  assert.match(dashboard, /href=\{`\/teacher\/sets\/\$\{encodeURIComponent\(sourceSetId\)\}`\}/);
  assert.match(route, /attemptId:\s*attempt\.attempt_id/);
  assert.match(route, /setId:\s*attempt\.set_id/);
  assert.doesNotMatch(dashboard, /encodeURIComponent\(set\.displayNumber\)/);
});
