const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  TEACHER_PRACTICE_TASK_SHORT_LABELS,
  buildTeacherStudentReadingPractice,
  buildTeacherStudentWritingPractice,
  formatTeacherPracticeTaskSelection,
  parseTeacherPracticeTaskSelection,
  resolveTeacherWritingAttemptDisplayName
} = require("../lib/teacherStudentPractice.ts");
const {
  createHistoricalPracticeDisplayResolver
} = require("../lib/historicalPracticeDisplay.ts");
const {
  loadTeacherReadingItemMeta,
  loadTeacherStudentReadingPractice
} = require("../lib/teacherStudentPractice.server.ts");
const { buildReadingCatalogPublicPayload } = require("../lib/reading/catalog.ts");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");

/**
 * Test double for the cached public reading catalog: builds the exact payload
 * `loadCachedPublicReadingCatalog()` serves, from the same mock rows.
 */
function catalogLoaderFromRows(rows, loadedModules) {
  return async (taskType) => {
    loadedModules?.push(taskType);
    return buildReadingCatalogPublicPayload({
      taskType,
      items: rows.filter((row) => row.module === taskType)
    });
  };
}

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function readingItem(overrides) {
  return {
    logical_item_id: "ctw-a",
    module: "ctw",
    displayName: "题目001",
    scoringPointCount: 10,
    ...overrides
  };
}

function readingCatalogRow(overrides) {
  return {
    logical_item_id: "ctw-a",
    module: "ctw",
    title: null,
    first_seen_date: "2026-01-01",
    first_seen_source_label: "260101A-M1",
    first_seen_source_order: 1,
    question_count: 1,
    scored_item_count: 10,
    ...overrides
  };
}

function readingAttempt(overrides) {
  return {
    attempt_id: "r-1",
    student_id: "student-1",
    logical_item_id: "ctw-a",
    task_type: "ctw",
    status: "submitted",
    elapsed_seconds: 60,
    total_points: 10,
    correct_points: 1,
    submitted_at: "2026-09-22T01:00:00.000Z",
    ...overrides
  };
}

const ITEM_META = new Map([
  ["ctw-a", readingItem()],
  ["ctw-b", readingItem({ logical_item_id: "ctw-b", displayName: "题目002" })],
  ["rdl-a", readingItem({
    logical_item_id: "rdl-a",
    module: "rdl",
    displayName: "题目001 · Library Notice",
    scoringPointCount: 2
  })],
  ["rap-a", readingItem({
    logical_item_id: "rap-a",
    module: "rap",
    displayName: "题目001 · Passage",
    scoringPointCount: 5
  })]
].map(([, item]) => [item.logical_item_id, item]));

test("Reading accuracy is weighted by total scoring points, not averaged percentages", () => {
  const practice = buildTeacherStudentReadingPractice({
    attempts: [
      readingAttempt({ attempt_id: "r-high", correct_points: 9, total_points: 10 }),
      readingAttempt({ attempt_id: "r-low", correct_points: 1, total_points: 2 })
    ],
    itemMeta: ITEM_META
  });

  assert.equal(practice.tasks.ctw.attempts, 2);
  assert.equal(practice.tasks.ctw.correctPoints, 10);
  assert.equal(practice.tasks.ctw.totalPoints, 12);
  assert.equal(practice.tasks.ctw.accuracy, 10 / 12);
  assert.notEqual(practice.tasks.ctw.accuracy, (0.9 + 0.5) / 2);
});

test("Reading wrongbook corrections stay out of the task cards but remain in records", () => {
  const practice = buildTeacherStudentReadingPractice({
    attempts: [readingAttempt({ attempt_id: "r-1", correct_points: 8, total_points: 10 })],
    wrongbookAttempts: [
      {
        ...readingAttempt({
          attempt_id: "w-1",
          logical_item_id: "rdl-a",
          task_type: "rdl",
          correct_points: 1,
          total_points: 2
        }),
        scope: "today"
      }
    ],
    itemMeta: ITEM_META
  });

  assert.equal(practice.tasks.rdl.attempts, 0);
  assert.equal(practice.tasks.rdl.totalPoints, 0);
  assert.equal(practice.tasks.ctw.attempts, 1);
  assert.equal(practice.fullSet.attempts, 0);
  assert.equal(practice.fullSet.totalPoints, 0);
  const wrongbook = practice.records.find((record) => record.attemptId === "w-1");
  assert.equal(wrongbook.kind, "wrongbook");
  assert.equal(wrongbook.scope, "today");
  assert.equal(wrongbook.taskType, "rdl");
});

test("one wrong-question session folds its per-material attempts into a single record", () => {
  const practice = buildTeacherStudentReadingPractice({
    attempts: [],
    wrongbookAttempts: [
      {
        ...readingAttempt({
          attempt_id: "w-1",
          logical_item_id: "rap-a",
          task_type: "rap",
          correct_points: 1,
          total_points: 2,
          elapsed_seconds: 30,
          submitted_at: "2026-09-22T02:00:00.000Z"
        }),
        scope: "history"
      },
      {
        ...readingAttempt({
          attempt_id: "w-2",
          logical_item_id: "rap-b",
          task_type: "rap",
          correct_points: 0,
          total_points: 1,
          elapsed_seconds: 20,
          submitted_at: "2026-09-22T02:02:00.000Z"
        }),
        scope: "history"
      },
      {
        ...readingAttempt({
          attempt_id: "w-3",
          logical_item_id: "rap-c",
          task_type: "rap",
          correct_points: 1,
          total_points: 1,
          elapsed_seconds: 10,
          submitted_at: "2026-09-22T02:01:00.000Z"
        }),
        scope: "history"
      },
      {
        ...readingAttempt({
          attempt_id: "w-entry",
          logical_item_id: "rap-a",
          task_type: "rap",
          correct_points: 0,
          total_points: 1,
          elapsed_seconds: 5,
          submitted_at: "2026-09-22T03:00:00.000Z"
        }),
        scope: "today"
      }
    ],
    wrongbookSessions: [
      {
        session_id: "s-1",
        task_type: "rap",
        mode: "history",
        status: "completed",
        progress: {
          "rap-a": { attemptId: "w-1" },
          "rap-b": { attemptId: "w-2" },
          "rap-c": { attemptId: "w-3" }
        }
      }
    ],
    itemMeta: ITEM_META,
    studentId: "student-1"
  });

  const sessionRecords = practice.records.filter(
    (record) => record.recordId.startsWith("wrongbook-session:")
  );
  assert.equal(sessionRecords.length, 1);
  const session = sessionRecords[0];
  assert.equal(session.recordId, "wrongbook-session:s-1");
  assert.equal(session.kind, "wrongbook");
  // The record name matches the Writing wrongbook records and never carries a
  // material count.
  assert.equal(session.title, "历史错题");
  assert.equal(session.scope, "history");
  assert.equal(session.taskType, "rap");
  assert.deepEqual(session.metric, {
    kind: "objective",
    correct: 2,
    total: 4,
    accuracy: 0.5
  });
  assert.equal(session.durationSeconds, 60);
  assert.equal(session.submittedAt, "2026-09-22T02:02:00.000Z");
  // The drill-down opens the session's earliest material.
  assert.equal(session.attemptId, "w-1");
  assert.equal(session.href, "/teacher/students/student-1/reading/wrongbook-attempts/w-1");

  // The session's per-material rows are gone; a correction outside any session
  // (entry correction) keeps its own record.
  assert.equal(practice.records.some((record) => record.attemptId === "w-2"), false);
  assert.equal(practice.records.some((record) => record.attemptId === "w-3"), false);
  const entry = practice.records.find((record) => record.attemptId === "w-entry");
  assert.equal(entry.kind, "wrongbook");
  assert.equal(entry.scope, "today");
  // Entry corrections read as 错题订正·材料名; the material name moved into the
  // title instead of standing alone.
  assert.equal(entry.title, "错题订正·题目001 · Passage");
});

test("an unfinished wrong-question session produces no record at all", () => {
  const practice = buildTeacherStudentReadingPractice({
    attempts: [],
    wrongbookAttempts: [
      {
        ...readingAttempt({
          attempt_id: "u-1",
          logical_item_id: "rap-a",
          task_type: "rap",
          correct_points: 0,
          total_points: 1,
          submitted_at: "2026-09-22T02:00:00.000Z"
        }),
        scope: "history"
      },
      {
        ...readingAttempt({
          attempt_id: "u-2",
          logical_item_id: "rap-e",
          task_type: "rap",
          correct_points: 0,
          total_points: 1,
          submitted_at: "2026-09-22T02:05:00.000Z"
        }),
        scope: "history"
      }
    ],
    wrongbookSessions: [
      {
        session_id: "s-active",
        task_type: "rap",
        mode: "today",
        status: "active",
        progress: { "rap-a": { attemptId: "u-1" } }
      }
    ],
    itemMeta: ITEM_META,
    studentId: "student-1"
  });

  // The unfinished session's material never becomes a partial session record …
  assert.equal(
    practice.records.some((record) => record.recordId.startsWith("wrongbook-session:")),
    false
  );
  // … and it does not fall back to a material-sized row either.
  assert.equal(practice.records.some((record) => record.attemptId === "u-1"), false);
  // A correction that is not part of the unfinished session still shows up.
  assert.ok(practice.records.some((record) => record.attemptId === "u-2"));
});

test("a finished today session is named 今日错题", () => {
  const practice = buildTeacherStudentReadingPractice({
    attempts: [],
    wrongbookAttempts: [
      {
        ...readingAttempt({
          attempt_id: "t-1",
          logical_item_id: "ctw-a",
          task_type: "ctw",
          correct_points: 1,
          total_points: 1,
          submitted_at: "2026-09-22T04:00:00.000Z"
        }),
        scope: "today"
      }
    ],
    wrongbookSessions: [
      {
        session_id: "s-today",
        task_type: "ctw",
        mode: "today",
        status: "completed",
        progress: { "ctw-a": { attemptId: "t-1" } }
      }
    ],
    itemMeta: ITEM_META,
    studentId: "student-1"
  });

  const session = practice.records.find((record) =>
    record.recordId === "wrongbook-session:s-today");
  assert.equal(session.title, "今日错题");
  assert.equal(session.scope, "today");
});

test("Reading Full Set counts one whole practice in its own card, never in CTW/RDL/RAP", () => {
  const answers = [
    ...pointRows("m1-ctw-1", 7, 3),
    ...pointRows("m1-rdl-1", 2, 0),
    ...pointRows("m2-ctw-1", 10, 0),
    ...pointRows("m2-rap-1", 3, 2)
  ];
  const practice = buildTeacherStudentReadingPractice({
    attempts: [],
    fullSetAttempts: [{ attempt_id: "fs-1", full_set_id: "20260922", completed_at: "2026-09-22T05:00:00.000Z" }],
    fullSetModules: [
      {
        attempt_id: "fs-1",
        module_attempt_id: "m1",
        module_number: 1,
        started_at: "2026-09-22T04:00:00.000Z",
        submitted_at: "2026-09-22T04:18:00.000Z",
        time_limit_seconds: 1230
      },
      {
        attempt_id: "fs-1",
        module_attempt_id: "m2",
        module_number: 2,
        started_at: "2026-09-22T04:18:00.000Z",
        submitted_at: "2026-09-22T04:26:00.000Z",
        time_limit_seconds: 540
      }
    ],
    fullSetAnswers: answers,
    itemMeta: ITEM_META
  });

  // Full Set work never inflates the single-task cards.
  assert.equal(practice.tasks.ctw.attempts, 0);
  assert.equal(practice.tasks.ctw.correctPoints, 0);
  assert.equal(practice.tasks.ctw.totalPoints, 0);
  assert.equal(practice.tasks.rdl.attempts, 0);
  assert.equal(practice.tasks.rdl.totalPoints, 0);
  assert.equal(practice.tasks.rap.attempts, 0);
  assert.equal(practice.tasks.rap.totalPoints, 0);

  // The dedicated Full Set card counts ONE completed Full Set as one practice
  // and weights accuracy by its own cumulative scoring points.
  assert.equal(practice.fullSet.attempts, 1);
  assert.equal(practice.fullSet.correctPoints, 22);
  assert.equal(practice.fullSet.totalPoints, 27);
  assert.equal(practice.fullSet.accuracy, 22 / 27);

  // One Full Set is ONE record: both modules, one summed score, named after the
  // Full Set the student sees on the result page.
  const fullSetRecords = practice.records.filter((record) => record.kind === "full_set");
  assert.equal(fullSetRecords.length, 1);
  const fullSetRecord = fullSetRecords[0];
  assert.equal(fullSetRecord.taskType, "full_set");
  assert.equal(fullSetRecord.recordId, "full_set:fs-1");
  assert.equal(fullSetRecord.title, "Full Set 20260922");
  assert.equal(fullSetRecord.metric.correct, 22);
  assert.equal(fullSetRecord.metric.total, 27);
  assert.equal(fullSetRecord.durationSeconds, 18 * 60 + 8 * 60);

  function pointRows(occurrenceId, correct, incorrect) {
    const item = occurrenceId.includes("rdl")
      ? "rdl-a"
      : occurrenceId.includes("rap")
        ? "rap-a"
        : occurrenceId.includes("m2")
          ? "ctw-b"
          : "ctw-a";
    const moduleId = occurrenceId.startsWith("m1") ? "m1" : "m2";
    return [
      ...Array.from({ length: correct }, (_, index) => ({
        module_attempt_id: moduleId,
        occurrence_id: occurrenceId,
        logical_item_id: item,
        is_correct: true,
        answer_id: `${occurrenceId}-c${index}`
      })),
      ...Array.from({ length: incorrect }, (_, index) => ({
        module_attempt_id: moduleId,
        occurrence_id: occurrenceId,
        logical_item_id: item,
        is_correct: false,
        answer_id: `${occurrenceId}-w${index}`
      }))
    ];
  }
});

test("Reading Full Set attempts without two submitted modules are ignored", () => {
  const practice = buildTeacherStudentReadingPractice({
    attempts: [],
    fullSetAttempts: [{ attempt_id: "fs-1", full_set_id: "20260922", completed_at: "2026-09-22T05:00:00.000Z" }],
    fullSetModules: [
      {
        attempt_id: "fs-1",
        module_attempt_id: "m1",
        module_number: 1,
        started_at: "2026-09-22T04:00:00.000Z",
        submitted_at: "2026-09-22T04:18:00.000Z",
        time_limit_seconds: 1230
      }
    ],
    fullSetAnswers: [],
    itemMeta: ITEM_META
  });

  assert.equal(practice.tasks.ctw.attempts, 0);
  assert.equal(practice.fullSet.attempts, 0);
  assert.equal(practice.fullSet.totalPoints, 0);
  assert.equal(practice.records.length, 0);
});

test("single-task cards and the Full Set card accumulate independently", () => {
  const practice = buildTeacherStudentReadingPractice({
    attempts: [
      readingAttempt({ attempt_id: "r-ctw", task_type: "ctw", correct_points: 8, total_points: 10 }),
      readingAttempt({
        attempt_id: "r-rap",
        logical_item_id: "rap-a",
        task_type: "rap",
        correct_points: 2,
        total_points: 5
      })
    ],
    fullSetAttempts: [
      { attempt_id: "fs-1", full_set_id: "20260922", completed_at: "2026-09-22T05:00:00.000Z" },
      { attempt_id: "fs-2", full_set_id: "20260923", completed_at: "2026-09-23T05:00:00.000Z" }
    ],
    fullSetModules: [
      ...fullSetModules("fs-1", "2026-09-22"),
      ...fullSetModules("fs-2", "2026-09-23")
    ],
    fullSetAnswers: [
      // fs-1: rdl 1/2 + rap 3/5 -> 4/7 points.
      ...answerRows("m1-fs-1", "rdl-a", 1, 1),
      ...answerRows("m2-fs-1", "rap-a", 3, 2),
      // fs-2: rdl 2/2 -> 2/2 points.
      ...answerRows("m1-fs-2", "rdl-a", 2, 0)
    ],
    itemMeta: ITEM_META
  });

  // Ordinary CTW/RDL/RAP practice counts only itself.
  assert.equal(practice.tasks.ctw.attempts, 1);
  assert.equal(practice.tasks.ctw.correctPoints, 8);
  assert.equal(practice.tasks.ctw.totalPoints, 10);
  assert.equal(practice.tasks.rdl.attempts, 0);
  assert.equal(practice.tasks.rap.attempts, 1);
  assert.equal(practice.tasks.rap.correctPoints, 2);
  assert.equal(practice.tasks.rap.totalPoints, 5);

  // Full Sets accumulate as whole runs: 2 practices, points weighted together
  // (4/7 + 2/2 = 6/9), not as per-module attempts.
  assert.equal(practice.fullSet.attempts, 2);
  assert.equal(practice.fullSet.correctPoints, 6);
  assert.equal(practice.fullSet.totalPoints, 9);
  assert.equal(practice.fullSet.accuracy, 6 / 9);

  function fullSetModules(attemptId, day) {
    return [
      {
        attempt_id: attemptId,
        module_attempt_id: `m1-${attemptId}`,
        module_number: 1,
        started_at: `${day}T04:00:00.000Z`,
        submitted_at: `${day}T04:18:00.000Z`,
        time_limit_seconds: 1230
      },
      {
        attempt_id: attemptId,
        module_attempt_id: `m2-${attemptId}`,
        module_number: 2,
        started_at: `${day}T04:18:00.000Z`,
        submitted_at: `${day}T04:26:00.000Z`,
        time_limit_seconds: 540
      }
    ];
  }

  function answerRows(moduleId, logicalItemId, correct, incorrect) {
    const occurrenceId = `${moduleId}-${logicalItemId}`;
    return [
      ...Array.from({ length: correct }, (_, index) => ({
        module_attempt_id: moduleId,
        occurrence_id: occurrenceId,
        logical_item_id: logicalItemId,
        is_correct: true,
        answer_id: `${occurrenceId}-c${index}`
      })),
      ...Array.from({ length: incorrect }, (_, index) => ({
        module_attempt_id: moduleId,
        occurrence_id: occurrenceId,
        logical_item_id: logicalItemId,
        is_correct: false,
        answer_id: `${occurrenceId}-w${index}`
      }))
    ];
  }
});

test("BAS accuracy sums correct over total and ignores wrongbook attempts in the card", () => {
  const practice = buildTeacherStudentWritingPractice({
    basAttempts: [
      {
        attempt_id: "b-1",
        set_id: "set-1",
        set_title: "旧题名",
        correct_count: 8,
        total_questions: 10,
        time_spent_seconds: 120,
        submitted_at: "2026-09-22T02:00:00.000Z"
      },
      {
        attempt_id: "b-2",
        set_id: "set-1",
        set_title: "旧题名",
        correct_count: 6,
        total_questions: 10,
        time_spent_seconds: 90,
        submitted_at: "2026-09-22T03:00:00.000Z"
      },
      {
        attempt_id: "b-wrongbook",
        set_id: "wrongbook-today-20260922",
        set_title: "错题订正",
        correct_count: 1,
        total_questions: 1,
        time_spent_seconds: 10,
        submitted_at: "2026-09-22T04:00:00.000Z"
      }
    ],
    basTitles: new Map([["set-1", "套题031"]]),
    studentId: "student-1",
    writingAttempts: [],
    writingDisplayNames: new Map()
  });

  assert.equal(practice.tasks.build_sentence.attempts, 2);
  assert.equal(practice.tasks.build_sentence.correctCount, 14);
  assert.equal(practice.tasks.build_sentence.totalQuestions, 20);
  assert.equal(practice.tasks.build_sentence.accuracy, 0.7);

  const official = practice.records.find((record) => record.attemptId === "b-1");
  assert.equal(official.title, "套题031");
  assert.equal(official.href, "/teacher/students/student-1/attempts/b-1");
  const wrongbook = practice.records.find((record) => record.attemptId === "b-wrongbook");
  assert.equal(wrongbook.kind, "wrongbook");
  assert.equal(wrongbook.scope, "today");
  assert.equal(wrongbook.title, "今日错题");
  assert.equal(wrongbook.href, "/teacher/students/student-1/attempts/b-wrongbook");
});

test("Email and Academic Discussion count every submitted attempt but average only published scores", () => {
  const practice = buildTeacherStudentWritingPractice({
    basAttempts: [],
    studentId: "student-1",
    writingAttempts: [
      writingAttempt({ attempt_id: "e-1", task_type: "email", word_count: 180 }),
      writingAttempt({ attempt_id: "e-2", task_type: "email", word_count: 190 }),
      writingAttempt({ attempt_id: "e-3", task_type: "email", word_count: 200 }),
      writingAttempt({ attempt_id: "a-1", task_type: "academic_discussion", word_count: 150 })
    ],
    writingDisplayNames: new Map([
      ["e-1", "题目021 Request for Schedule Change"],
      ["e-2", "题目021 Request for Schedule Change"],
      ["e-3", "题目021 Request for Schedule Change"],
      ["a-1", "题目003 Government Funding"]
    ]),
    reviewScores: new Map([["e-1", 4], ["e-2", 5]])
  });

  assert.equal(practice.tasks.email.attempts, 3);
  assert.equal(practice.tasks.email.scoredAttempts, 2);
  assert.equal(practice.tasks.email.averageScore, 4.5);
  assert.equal(practice.tasks.academic_discussion.attempts, 1);
  assert.equal(practice.tasks.academic_discussion.scoredAttempts, 0);
  assert.equal(practice.tasks.academic_discussion.averageScore, null);

  const unscored = practice.records.find((record) => record.attemptId === "e-3");
  assert.equal(unscored.metric.hasScore, false);
  assert.equal(unscored.metric.score, null);
  assert.equal(unscored.metric.wordCount, 200);
  assert.equal(unscored.title, "题目021 Request for Schedule Change");
  assert.equal(unscored.href, "/teacher/writing/reviews/e-3");

  function writingAttempt(overrides) {
    return {
      attempt_id: "e-x",
      assignment_id: null,
      task_type: "email",
      question_id: "q-1",
      word_count: 100,
      elapsed_seconds: 300,
      submitted_at: "2026-09-22T05:00:00.000Z",
      ...overrides
    };
  }
});

test("custom assignment titles stay custom and question-bank assignments use the logical display name", () => {
  const resolver = createHistoricalPracticeDisplayResolver({
    items: [
      {
        item_id: "email-item-21",
        task_type: "email",
        display_number: "021",
        display_title: "Request for Schedule Change",
        is_active: true
      }
    ],
    sources: [
      {
        source_id: "source-1",
        item_id: "email-item-21",
        task_type: "email",
        source_set_id: null,
        source_question_id: "q-bank-1"
      }
    ]
  });

  const custom = resolveTeacherWritingAttemptDisplayName({
    assignmentId: "assignment-custom",
    assignmentTitle: "教师自定义作业",
    assignmentQuestionSource: "custom",
    fallbackTitle: "教师自定义作业",
    questionId: "q-custom-1",
    resolver,
    taskType: "email"
  });
  assert.equal(custom, "教师自定义作业");

  const questionBank = resolveTeacherWritingAttemptDisplayName({
    assignmentId: "assignment-bank",
    assignmentTitle: "作业标题",
    assignmentQuestionSource: "question_bank",
    fallbackTitle: "作业标题",
    questionId: "q-bank-1",
    resolver,
    taskType: "email"
  });
  assert.equal(questionBank, "题目021 Request for Schedule Change");
});

test("scoped Reading metadata takes numbers and titles from the public catalog", async () => {
  const rows = [
    readingCatalogRow({ logical_item_id: "ctw-a", first_seen_date: "2026-01-01", first_seen_source_order: 1, title: "Alpha Topic" }),
    readingCatalogRow({ logical_item_id: "ctw-b", first_seen_date: "2026-01-01", first_seen_source_order: 2, title: "Beta Topic" }),
    readingCatalogRow({ logical_item_id: "ctw-c", first_seen_date: "2026-01-05", first_seen_source_order: 1, title: "Gamma Topic" }),
    readingCatalogRow({
      logical_item_id: "ctw-d",
      first_seen_date: "2026-02-01",
      first_seen_source_order: 1,
      title: "Night Sky"
    }),
    readingCatalogRow({ logical_item_id: "ctw-e", first_seen_date: "2026-02-01", first_seen_source_order: 2, title: "Epsilon Topic" }),
    readingCatalogRow({ logical_item_id: "rdl-x", module: "rdl", title: "Library Notice", first_seen_date: "2026-01-02" })
  ];
  const db = createMockSupabase({ reading_logical_items: rows });
  const loadedModules = [];

  const meta = await loadTeacherReadingItemMeta(
    db,
    ["ctw-b", "ctw-d", "rdl-x"],
    catalogLoaderFromRows(rows, loadedModules)
  );

  // Only the modules actually involved are loaded, once each.
  assert.deepEqual(loadedModules.sort(), ["ctw", "rdl"]);
  assert.equal(meta.size, 3);
  // Numbers and titles are exactly the public catalog's, including items with
  // different first-seen dates inside the same module.
  assert.equal(meta.get("ctw-b").displayName, "题目002 · Beta Topic");
  assert.equal(meta.get("ctw-d").displayName, "题目004 · Night Sky");
  assert.equal(meta.get("rdl-x").displayName, "题目001 · Library Notice");
  // scoringPointCount still comes from the scoped live row.
  assert.equal(meta.get("ctw-d").scoringPointCount, 10);
});

test("teacher Reading numbers follow the catalog revision without a count walk", async () => {
  const rows = [
    readingCatalogRow({ logical_item_id: "ctw-a", first_seen_date: "2026-01-01", first_seen_source_order: 1, title: "Alpha Topic" }),
    readingCatalogRow({ logical_item_id: "ctw-b", first_seen_date: "2026-01-01", first_seen_source_order: 2, title: "Beta Topic" })
  ];
  const db = createMockSupabase({ reading_logical_items: rows });
  // A backfilled earlier item shifts every existing number in the catalog.
  const revisedRows = [
    readingCatalogRow({
      logical_item_id: "ctw-earlier",
      first_seen_date: "2025-12-01",
      first_seen_source_order: 1,
      title: "Earlier Topic"
    }),
    ...rows
  ];

  const meta = await loadTeacherReadingItemMeta(
    db,
    ["ctw-a"],
    catalogLoaderFromRows(revisedRows)
  );

  assert.equal(meta.get("ctw-a").displayName, "题目002 · Alpha Topic");
});

test("a scoped item missing from the catalog falls back to the live rank", async () => {
  const rows = [
    readingCatalogRow({ logical_item_id: "ctw-a", first_seen_date: "2026-01-01", first_seen_source_order: 1, title: "Alpha Topic" }),
    readingCatalogRow({ logical_item_id: "ctw-b", first_seen_date: "2026-01-01", first_seen_source_order: 2, title: "Beta Topic" }),
    readingCatalogRow({ logical_item_id: "ctw-c", first_seen_date: "2026-01-05", first_seen_source_order: 1, title: "Gamma Topic" })
  ];
  const db = createMockSupabase({ reading_logical_items: rows });
  const partialCatalog = rows.filter((row) => row.logical_item_id !== "ctw-b");

  const meta = await loadTeacherReadingItemMeta(
    db,
    ["ctw-a", "ctw-b"],
    catalogLoaderFromRows(partialCatalog)
  );

  // The fallback covers every scoped item so the numbers stay consistent.
  assert.equal(meta.get("ctw-a").displayName, "题目001 · Alpha Topic");
  assert.equal(meta.get("ctw-b").displayName, "题目002 · Beta Topic");
});

test("a failing catalog build degrades to the scoped rank fallback", async () => {
  const rows = [
    readingCatalogRow({ logical_item_id: "ctw-a", first_seen_date: "2026-01-01", first_seen_source_order: 1, title: "Alpha Topic" }),
    readingCatalogRow({ logical_item_id: "ctw-b", first_seen_date: "2026-01-01", first_seen_source_order: 2, title: "Beta Topic" })
  ];
  const db = createMockSupabase({ reading_logical_items: rows });

  const meta = await loadTeacherReadingItemMeta(
    db,
    ["ctw-b"],
    async () => {
      throw new Error("catalog cache unavailable");
    }
  );

  assert.equal(meta.get("ctw-b").displayName, "题目002 · Beta Topic");
  assert.equal(meta.get("ctw-b").scoringPointCount, 10);
});

test("day view reads only the sessions that can own the day's wrong-question attempts", async () => {
  const rows = [
    readingCatalogRow({ logical_item_id: "ctw-a", first_seen_date: "2026-01-01", title: "Alpha Topic" })
  ];
  const db = createMockSupabase({
    reading_logical_items: rows,
    reading_attempts: [],
    reading_wrongbook_attempts: [
      {
        attempt_id: "w-day",
        student_id: "student-1",
        logical_item_id: "ctw-a",
        task_type: "ctw",
        scope: "history",
        status: "submitted",
        elapsed_seconds: 30,
        total_points: 10,
        correct_points: 4,
        submitted_at: "2026-10-02T03:00:00.000Z"
      }
    ],
    student_wrong_question_sessions: [
      {
        session_id: "s-own",
        student_id: "student-1",
        task_type: "ctw",
        mode: "history",
        status: "completed",
        created_at: "2026-10-01T20:00:00.000Z",
        updated_at: "2026-10-02T03:00:05.000Z",
        progress: {
          "ctw-a": {
            attemptId: "w-day",
            correctPoints: 4,
            submittedAt: "2026-10-02T03:00:00.000Z",
            totalPoints: 10
          }
        }
      },
      {
        // Stale session, updated long before the day: never loaded.
        session_id: "s-stale",
        student_id: "student-1",
        task_type: "ctw",
        mode: "history",
        status: "completed",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T01:00:00.000Z",
        progress: { "ctw-a": { attemptId: "w-old" } }
      },
      {
        // Created after the day: never loaded.
        session_id: "s-future",
        student_id: "student-1",
        task_type: "ctw",
        mode: "today",
        status: "active",
        created_at: "2026-10-03T00:00:00.000Z",
        updated_at: "2026-10-03T01:00:00.000Z",
        progress: {}
      },
      {
        // Different task type: filtered out with the day's task types.
        session_id: "s-rdl",
        student_id: "student-1",
        task_type: "rdl",
        mode: "history",
        status: "completed",
        created_at: "2026-10-01T20:00:00.000Z",
        updated_at: "2026-10-02T04:00:00.000Z",
        progress: { "rdl-x": { attemptId: "w-rdl" } }
      }
    ]
  });

  const practice = await loadTeacherStudentReadingPractice(
    db,
    "student-1",
    "2026-10-02T00:00:00.000Z",
    "2026-10-03T00:00:00.000Z",
    catalogLoaderFromRows(rows)
  );

  const session = practice.records.find(
    (record) => record.recordId === "wrongbook-session:s-own"
  );
  assert.equal(session.kind, "wrongbook");
  assert.equal(session.title, "历史错题");
  assert.equal(session.submittedAt, "2026-10-02T03:00:00.000Z");
  assert.equal(session.attemptId, "w-day");
  assert.equal(session.metric.correct, 4);
  assert.equal(session.metric.total, 10);
  // The session owns the attempt: no standalone Entry record for it.
  assert.equal(practice.records.filter((record) => record.attemptId === "w-day").length, 1);
});

test("an unfinished cross-day session hides its day attempts without an Entry record", async () => {
  const rows = [
    readingCatalogRow({ logical_item_id: "ctw-a", first_seen_date: "2026-01-01", title: "Alpha Topic" })
  ];
  const db = createMockSupabase({
    reading_logical_items: rows,
    reading_attempts: [],
    reading_wrongbook_attempts: [
      {
        attempt_id: "w-active",
        student_id: "student-1",
        logical_item_id: "ctw-a",
        task_type: "ctw",
        scope: "today",
        status: "submitted",
        elapsed_seconds: 5,
        total_points: 10,
        correct_points: 3,
        submitted_at: "2026-10-02T05:00:00.000Z"
      }
    ],
    student_wrong_question_sessions: [
      {
        session_id: "s-active",
        student_id: "student-1",
        task_type: "ctw",
        mode: "today",
        status: "active",
        created_at: "2026-10-01T10:00:00.000Z",
        updated_at: "2026-10-02T05:00:01.000Z",
        progress: { "ctw-a": { attemptId: "w-active" } }
      }
    ]
  });

  const practice = await loadTeacherStudentReadingPractice(
    db,
    "student-1",
    "2026-10-02T00:00:00.000Z",
    "2026-10-03T00:00:00.000Z",
    catalogLoaderFromRows(rows)
  );

  assert.deepEqual(practice.records, []);
});

test("a day without Reading wrong-question attempts skips the session lookup", async () => {
  const db = createMockSupabase({
    reading_logical_items: [],
    reading_attempts: [],
    reading_wrongbook_attempts: [],
    reading_full_set_attempts: [],
    student_wrong_question_sessions: []
  });
  let sessionQueried = false;
  const originalFrom = db.from.bind(db);
  db.from = (table) => {
    if (table === "student_wrong_question_sessions") {
      sessionQueried = true;
      throw new Error("session lookup must be skipped");
    }
    return originalFrom(table);
  };

  const practice = await loadTeacherStudentReadingPractice(
    db,
    "student-1",
    "2026-10-02T00:00:00.000Z",
    "2026-10-03T00:00:00.000Z",
    async () => {
      throw new Error("catalog must not load without scoped items");
    }
  );

  assert.equal(sessionQueried, false);
  assert.deepEqual(practice.records, []);
});

test("a session spanning days keeps the day's attempt time and grouping", () => {
  const practice = buildTeacherStudentReadingPractice({
    attempts: [],
    wrongbookAttempts: [
      {
        ...readingAttempt({
          attempt_id: "w-cross",
          logical_item_id: "rap-a",
          task_type: "rap",
          correct_points: 2,
          total_points: 5,
          submitted_at: "2026-10-02T02:00:00.000Z"
        }),
        scope: "history"
      }
    ],
    wrongbookSessions: [
      {
        session_id: "s-cross",
        task_type: "rap",
        mode: "history",
        status: "completed",
        progress: { "rap-a": { attemptId: "w-cross" } }
      }
    ],
    itemMeta: ITEM_META
  });

  const session = practice.records.find(
    (record) => record.recordId === "wrongbook-session:s-cross"
  );
  assert.equal(session.submittedAt, "2026-10-02T02:00:00.000Z");
  assert.equal(session.metric.correct, 2);
  assert.equal(session.metric.total, 5);
  assert.equal(session.attemptId, "w-cross");
  assert.equal(practice.records.filter((record) => record.attemptId === "w-cross").length, 1);
});

test("teacher task filter params round-trip date and filter state", () => {
  const all = parseTeacherPracticeTaskSelection(undefined);
  assert.equal(formatTeacherPracticeTaskSelection(all), "");
  assert.equal(formatTeacherPracticeTaskSelection(parseTeacherPracticeTaskSelection("")), "");
  assert.deepEqual(parseTeacherPracticeTaskSelection(""), all);
  assert.deepEqual(parseTeacherPracticeTaskSelection("unknown"), all);

  const partial = parseTeacherPracticeTaskSelection("ctw,rdl,build_sentence");
  assert.equal(partial.ctw, true);
  assert.equal(partial.rdl, true);
  assert.equal(partial.rap, false);
  assert.equal(partial.full_set, false);
  assert.equal(partial.build_sentence, true);
  assert.equal(partial.email, false);
  assert.equal(partial.academic_discussion, false);
  assert.equal(formatTeacherPracticeTaskSelection(partial), "ctw,rdl,build_sentence");
  assert.deepEqual(parseTeacherPracticeTaskSelection("ctw,rdl,build_sentence"), partial);

  const none = parseTeacherPracticeTaskSelection("none");
  assert.deepEqual(none, {
    ctw: false,
    rdl: false,
    rap: false,
    full_set: false,
    build_sentence: false,
    email: false,
    academic_discussion: false
  });
  assert.equal(formatTeacherPracticeTaskSelection(none), "none");
  assert.deepEqual(parseTeacherPracticeTaskSelection("none"), none);
});

test("checkbox short labels match the product copy", () => {  assert.deepEqual(TEACHER_PRACTICE_TASK_SHORT_LABELS, {
    ctw: "CTW",
    rdl: "RDL",
    rap: "RAP",
    full_set: "FS",
    build_sentence: "BAS",
    email: "WE",
    academic_discussion: "AD"
  });
});

test("student detail page never calls /api/teacher/stats or the global stats hook", () => {
  const dashboard = read("components/TeacherDashboard.tsx");
  const summaryRegion = dashboard.match(
    /export function TeacherStudentSummary[\s\S]*?export function TeacherSetsList/
  )?.[0] ?? "";
  assert.match(summaryRegion, /TeacherStudentPracticeWorkspace/);
  assert.doesNotMatch(summaryRegion, /useTeacherStats/);
  assert.doesNotMatch(summaryRegion, /TEACHER_STATS_CACHE_KEY/);
  assert.doesNotMatch(summaryRegion, /\/api\/teacher\/stats/);

  const setRegion = dashboard.match(
    /export function TeacherStudentSetDetails[\s\S]*?export function TeacherStudentQuestionDetail/
  )?.[0] ?? "";
  assert.doesNotMatch(setRegion, /useTeacherStats/);
  assert.doesNotMatch(setRegion, /\/api\/teacher\/stats/);
  assert.match(setRegion, /loadTeacherStudentSetDetails\(studentId, groupId\)/);
  assert.match(
    read("components/TeacherDashboard.tsx"),
    /`\/api\/teacher\/students\/\$\{encodeURIComponent\(studentId\)\}\/bas\/sets\/\$\{encodeURIComponent\(groupId\)\}`/
  );

  const answerRegion = dashboard.match(
    /export function TeacherStudentQuestionDetail[\s\S]*?export function TeacherSetsList/
  )?.[0] ?? "";
  assert.doesNotMatch(answerRegion, /useTeacherStats/);
  assert.match(answerRegion, /loadTeacherStudentAnswerDetail\(studentId, attemptAnswerId\)/);
  assert.match(
    read("components/TeacherDashboard.tsx"),
    /`\/api\/teacher\/students\/\$\{encodeURIComponent\(studentId\)\}\/answers\/\$\{encodeURIComponent\(attemptAnswerId\)\}`/
  );
});

test("practice API is single-student and single-range scoped with per-domain authorization", () => {
  const route = read("app/api/teacher/students/[studentId]/practice/route.ts");
  assert.match(route, /requireTeacherOnly\(bearerToken\(request\)\)/);
  assert.match(route, /loadTeacherScope/);
  assert.match(route, /boundDomains\.includes\("reading"\)/);
  assert.match(route, /boundDomains\.includes\("writing"\)/);
  assert.match(route, /if \(!readingAllowed && !writingAllowed\)/);
  assert.match(route, /parseDateBoundary/);
  // The route wires the cached public catalog into the reading loader.
  assert.match(route, /loadCachedPublicReadingCatalog/);
  assert.match(
    route,
    /loadTeacherStudentReadingPractice\([\s\S]{0,400}loadCachedPublicReadingCatalog/
  );
  assert.match(route, /loadTeacherStudentWritingPractice\(db, studentId, startAt, endAt\)/);
  assert.doesNotMatch(route, /listVisibleStudentIds|listTeacherStudentDomainBindings/);

  const lib = read("lib/teacherStudentPractice.server.ts");
  assert.match(lib, /\.eq\("student_id", studentId\)/);
  assert.match(lib, /\.eq\("user_id", studentId\)/);
  assert.match(lib, /\.gte\("submitted_at", startAt\)/);
  assert.match(lib, /\.lt\("submitted_at", endAt\)/);
  assert.match(lib, /\.gte\("completed_at", startAt\)/);
  assert.match(lib, /\.lt\("completed_at", endAt\)/);
  assert.match(lib, /\.in\("module_attempt_id", moduleIds\)/);
  assert.doesNotMatch(lib, /listVisibleStudentIds|listTeacherStudentDomainBindings/);
  assert.doesNotMatch(
    lib,
    /"response_text"|published_language_edits|published_content_feedback|ai_review_raw/
  );

  // Wrong-question sessions are scoped to the day's attempts instead of the
  // student's whole history, and are skipped entirely without such attempts.
  assert.match(lib, /\.in\("task_type", wrongbookTaskTypes\)/);
  assert.match(lib, /\.lt\("created_at", endAt\)/);
  assert.match(lib, /\.gte\("updated_at", startAt\)/);
  assert.match(lib, /wrongbookTaskTypes\.length[\s\S]{0,60}\? await readAllSupabaseRows/);

  // Display numbers come from the cached public catalog; the per-date COUNT
  // walk only runs for items missing from that catalog.
  assert.match(lib, /loadTeacherReadingItemMeta\(db, itemIds, loadCatalog\)/);
  assert.match(lib, /missingCatalogItems\.length > 0[\s\S]{0,80}loadReadingItemDisplayRanks/);
  assert.match(lib, /for \(const item of payload\.items\) items\.set\(item\.itemId, item\)/);
  assert.match(lib, /loadCatalog: TeacherReadingCatalogLoader/);
  assert.doesNotMatch(lib, /loadCachedPublicReadingCatalogSearchIndex/);
  assert.doesNotMatch(lib, /from "next\/cache"|from "\.\/reading\/catalogCache\.server\.ts"/);
});

test("BAS drill-down routes are scoped to one student and one set or answer", () => {
  const setRoute = read("app/api/teacher/students/[studentId]/bas/sets/[setId]/route.ts");
  assert.match(setRoute, /loadTeacherScope/);
  assert.match(setRoute, /scope\.studentDomains\.get\(studentId\)\?\.includes\("writing"\)/);
  assert.match(setRoute, /loadTeacherStudentBasSet\(db, studentId, requestedSetId\)/);

  const answerRoute = read("app/api/teacher/students/[studentId]/answers/[attemptAnswerId]/route.ts");
  assert.match(answerRoute, /loadTeacherScope/);
  assert.match(answerRoute, /scope\.studentDomains\.get\(studentId\)\?\.includes\("writing"\)/);
  assert.match(answerRoute, /loadTeacherStudentBasAnswerDetail\(db, studentId, attemptAnswerId\)/);

  const lib = read("lib/teacherStudentPractice.server.ts");
  assert.match(lib, /\.in\("attempt_id", attemptIds\)/);
  assert.match(lib, /\.eq\("attempt_answer_id", attemptAnswerId\)/);
  assert.match(lib, /\.eq\("attempt_id", attemptId\)/);
  assert.match(lib, /\.in\("question_id", questionIds\)/);
  assert.doesNotMatch(lib, /listVisibleStudentIds/);
});

test("student practice UI keeps one date control, one checkbox filter group, and no task refetch", () => {
  const component = read("components/teacher/TeacherStudentPracticeSection.tsx");
  assert.match(component, /TEACHER_STUDENT_PRACTICE_CACHE_PREFIX/);
  assert.match(component, /\$\{range\.startAt\}:\$\{range\.endAt\}/);
  assert.match(component, /const range = useMemo\(\(\) => localDayRange\(selectedDay\), \[selectedDay\]\)/);
  assert.match(component, /ALL_TASKS_SELECTED/);
  assert.match(component, /TEACHER_PRACTICE_TASK_TYPES\.map/);
  assert.match(component, /TEACHER_PRACTICE_TASK_SHORT_LABELS\[taskType\]/);
  assert.match(component, /type="checkbox"/);
  assert.match(component, /上一天/);
  assert.match(component, /下一天/);
  assert.match(component, /今天/);
  assert.match(component, /type="date"/);
  assert.match(component, /该日期暂无 Reading 练习记录。/);
  assert.match(component, /该日期暂无 Writing 练习记录。/);
  assert.doesNotMatch(component, /selectedTasks[^\n]*CACHE_PREFIX/);
});

test("Reading and Writing cards reuse the Sidebar icon components with domain tones", () => {
  const component = read("components/teacher/TeacherStudentPracticeSection.tsx");
  assert.match(component, /STUDENT_PRACTICE_ICONS\[taskType\]/);
  assert.match(component, /STUDENT_PRACTICE_ICONS\.build_sentence/);
  assert.match(component, /tone="reading"/);

  const icons = read("components/icons/StudentPracticeIcons.ts");
  assert.match(icons, /build_sentence: Puzzle/);
  assert.match(icons, /email: Mail/);
  assert.match(icons, /academic_discussion: MessageCircleMore/);
  assert.match(icons, /ctw: CompleteTheWordsIcon/);
  assert.match(icons, /rdl: FileText/);
  assert.match(icons, /rap: BookOpen/);
  assert.match(icons, /full_set: Library/);

  const ui = read("components/teacher/TeacherUI.tsx");
  assert.match(ui, /tone === "reading" && "bg-\[#eef6ff\] text-\[#347fdc\]"/);
  assert.match(ui, /tone === "primary" && "bg-student-primary-soft text-student-primary"/);
});

test("single-day Reading cards show CTW/RDL/RAP + Full Set on one equal four-column row", () => {
  const component = read("components/teacher/TeacherStudentPracticeSection.tsx");
  const readingSection = component.match(
    /\{view\.kind !== "range" && payload\.reading \? \([\s\S]*?\n          \) : null\}/
  )?.[0] ?? "";
  assert.notEqual(readingSection, "");
  // The Full Set card reuses the existing metric card, icon, label and tone.
  assert.match(readingSection, /STUDENT_PRACTICE_ICONS\.full_set/);
  assert.match(readingSection, /TEACHER_PRACTICE_TASK_LABELS\.full_set/);
  assert.match(readingSection, /payload\.reading!\.fullSet\.attempts/);
  assert.match(readingSection, /payload\.reading!\.fullSet\.totalPoints > 0/);
  // Desktop: four equal columns in one row; narrow screens keep a grid instead
  // of overflowing.
  assert.match(readingSection, /grid gap-4 sm:grid-cols-2 lg:grid-cols-4/);

  // The Writing row keeps its untouched three-column layout and gains no
  // Full Set card.
  const writingSection = component.match(
    /\{view\.kind !== "range" && payload\.writing \? \([\s\S]*?\n          \) : null\}/
  )?.[0] ?? "";
  assert.notEqual(writingSection, "");
  assert.match(writingSection, /sm:grid-cols-3/);
  assert.doesNotMatch(writingSection, /fullSet|full_set/);
});

test("both domains render through the same record list component", () => {
  const component = read("components/teacher/TeacherStudentPracticeSection.tsx");
  const listUsages = component.match(/<TeacherPracticeRecordList/g) ?? [];
  assert.equal(listUsages.length, 2);
  assert.match(component, /export function TeacherPracticeRecordList/);
  assert.match(component, /错题订正/);
});
