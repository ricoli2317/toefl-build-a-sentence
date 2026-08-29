const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildReadingCatalogPayload,
  readingCatalogDisplayNumber
} = require("../lib/reading/catalog.ts");
const {
  buildTeacherReadingStats
} = require("../lib/reading/teacherStats.ts");

const root = path.join(__dirname, "..");
const catalogRoute = fs.readFileSync(path.join(root, "app/api/reading/catalog/route.ts"), "utf8");
const catalogUi = fs.readFileSync(path.join(root, "components/reading/ReadingCatalog.tsx"), "utf8");
const readingPractice = fs.readFileSync(path.join(root, "components/reading/ReadingPractice.tsx"), "utf8");
const retakeUi = fs.readFileSync(path.join(root, "components/reading/ReadingRetakeButton.tsx"), "utf8");
const studentShell = fs.readFileSync(path.join(root, "components/student/StudentShell.tsx"), "utf8");
const studentDashboard = fs.readFileSync(path.join(root, "components/student/StudentDashboard.tsx"), "utf8");
const ctwIcon = fs.readFileSync(path.join(root, "components/icons/CompleteTheWordsIcon.tsx"), "utf8");
const studentDataCache = fs.readFileSync(path.join(root, "components/StudentDataCache.tsx"), "utf8");
const teacherRoute = fs.readFileSync(path.join(root, "app/api/teacher/reading/statistics/route.ts"), "utf8");
const teacherUi = fs.readFileSync(path.join(root, "components/reading/TeacherReadingStatistics.tsx"), "utf8");

function item(module, id, date, label, order, title = null, occurrenceDates = [date]) {
  return {
    logical_item_id: id,
    module,
    title,
    first_seen_date: date,
    first_seen_source_label: label,
    first_seen_source_order: order,
    question_count: module === "ctw" ? 1 : 3,
    scored_item_count: module === "ctw" ? 2 : 3,
    reading_source_occurrences: occurrenceDates.map((occurrence_date) => ({ occurrence_date }))
  };
}

function attempt(overrides) {
  return {
    attempt_id: "attempt-1",
    logical_item_id: "ctw-a",
    task_type: "ctw",
    status: "submitted",
    elapsed_seconds: 60,
    correct_points: 1,
    total_points: 2,
    submitted_at: "2026-06-01T01:00:00Z",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T01:00:00Z",
    ...overrides
  };
}

const catalogItems = [
  item("ctw", "ctw-b", "2026-05-02", "May 10", 1),
  item("ctw", "ctw-a", "2026-05-02", "May 2", 1),
  item("rdl", "rdl-a", "2026-05-01", "May", 1, "Library Notice"),
  item("rap", "rap-a", "2026-05-01", "May", 1, "Volcanoes")
];

test("Reading Catalog groups each product by stable logical item", () => {
  assert.deepEqual(buildReadingCatalogPayload({ taskType: "rdl", items: catalogItems, attempts: [] }).items.map((row) => row.itemId), ["rdl-a"]);
  assert.deepEqual(buildReadingCatalogPayload({ taskType: "rap", items: catalogItems, attempts: [] }).items.map((row) => row.itemId), ["rap-a"]);
  assert.equal(buildReadingCatalogPayload({ taskType: "ctw", items: catalogItems, attempts: [] }).items.length, 2);
});

test("dynamic numbering is deterministic and source labels sort naturally", () => {
  const payload = buildReadingCatalogPayload({ taskType: "ctw", items: catalogItems, attempts: [] });
  const byId = new Map(payload.items.map((row) => [row.itemId, row.displayNumber]));
  assert.equal(byId.get("ctw-a"), "001");
  assert.equal(byId.get("ctw-b"), "002");
});

test("practice header can derive the same zero-padded CTW suite number as the catalog", () => {
  assert.equal(readingCatalogDisplayNumber(catalogItems.filter((row) => row.module === "ctw"), "ctw-b"), "002");
  assert.equal(readingCatalogDisplayNumber(catalogItems.filter((row) => row.module === "ctw"), "missing"), null);
});

test("an earlier first-seen item can reflow numbers without changing identities", () => {
  const before = buildReadingCatalogPayload({ taskType: "ctw", items: catalogItems, attempts: [] });
  const after = buildReadingCatalogPayload({
    taskType: "ctw",
    items: [...catalogItems, item("ctw", "ctw-earlier", "2026-04-01", "April", 1)],
    attempts: []
  });
  assert.equal(before.items.find((row) => row.itemId === "ctw-a").displayNumber, "001");
  assert.equal(after.items.find((row) => row.itemId === "ctw-a").displayNumber, "002");
  assert.ok(after.items.some((row) => row.itemId === "ctw-a"));
});

test("a draft produces the in-progress state", () => {
  const payload = buildReadingCatalogPayload({ taskType: "ctw", items: catalogItems, attempts: [attempt({ status: "draft", submitted_at: null })] });
  assert.equal(payload.items.find((row) => row.itemId === "ctw-a").status, "in_progress");
});

test("a submitted attempt produces the completed state", () => {
  const payload = buildReadingCatalogPayload({ taskType: "ctw", items: catalogItems, attempts: [attempt({})] });
  assert.equal(payload.items.find((row) => row.itemId === "ctw-a").status, "completed");
});

test("Catalog exposes the latest submitted score and time summary", () => {
  const payload = buildReadingCatalogPayload({
    taskType: "ctw",
    items: catalogItems,
    attempts: [attempt({}), attempt({ attempt_id: "attempt-2", correct_points: 2, submitted_at: "2026-06-02T01:00:00Z", updated_at: "2026-06-02T01:00:00Z" })]
  });
  assert.deepEqual(payload.items.find((row) => row.itemId === "ctw-a").latestSubmittedAttempt, {
    attemptId: "attempt-2",
    correctPoints: 2,
    totalPoints: 2,
    accuracy: 1,
    elapsedSeconds: 60,
    submittedAt: "2026-06-02T01:00:00Z"
  });
});

test("Reading Catalog exposes every occurrence date newest-first without changing item identity", () => {
  const repeated = item(
    "rdl",
    "rdl-repeat",
    "2026-08-09",
    "8.9A",
    1,
    "Campus Notice",
    ["2026-08-09", "2026-08-11", "2026-08-09"]
  );
  const payload = buildReadingCatalogPayload({ taskType: "rdl", items: [repeated], attempts: [] });
  assert.equal(payload.items[0].itemId, "rdl-repeat");
  assert.deepEqual(payload.items[0].occurrenceDates, ["2026-08-11", "2026-08-09"]);
  assert.match(catalogRoute, /reading_source_occurrences\(occurrence_date\)/);
  assert.match(catalogUi, /formatOccurrenceDates\(item\.occurrenceDates\)/);
});

test("Reading Catalog metadata omits first-seen and recent score/date summaries", () => {
  assert.doesNotMatch(catalogUi, /首次出现|formatDateTime|Math\.round\(submitted\.accuracy/);
  assert.match(catalogUi, /function ReadingCatalogMetadata[\s\S]*formatOccurrenceDates\(item\.occurrenceDates\)/);
});

test("Catalog payload and query omit Reading content, answers, assets, and N+1 loops", () => {
  const payload = buildReadingCatalogPayload({ taskType: "rdl", items: catalogItems, attempts: [] });
  assert.doesNotMatch(JSON.stringify(payload), /passage|question.*content|studentAnswer|correctAnswer|selectionMap|imageUrl/i);
  assert.doesNotMatch(catalogRoute, /reading_questions|reading_passages|reading_materials|reading_ctw_slots|reading_question_options/);
  assert.equal((catalogRoute.match(/\.from\("reading_/g) || []).length, 2);
  assert.match(catalogRoute, /Promise\.all/);
});

test("Submit and draft/retake invalidate only the exact Reading catalog plus Reading History", () => {
  assert.match(readingPractice, /invalidate\(STUDENT_READING_HISTORY_CACHE_PREFIX\)/);
  assert.match(readingPractice, /invalidate\(studentReadingCatalogCacheKey\(result\.attempt\.taskType\)\)/);
  assert.match(readingPractice, /studentReadingCatalogCacheKey\(attemptResult\.attempt\.taskType\)/);
  assert.match(retakeUi, /invalidate\(studentReadingCatalogCacheKey\(payload\.attempt\.taskType\)\)/);
  for (const source of [readingPractice, retakeUi]) {
    assert.doesNotMatch(source, /STUDENT_(SETS|WRITING|LOGICAL|QUESTIONS|WRONG)_/);
  }
});

const statsInput = {
  profiles: [
    { id: "student-a", email: "a@example.com", full_name: "Alpha" },
    { id: "student-b", email: "b@example.com", full_name: "Beta" }
  ],
  items: [catalogItems[1], catalogItems[2], catalogItems[3]],
  attempts: [
    attempt({ attempt_id: "a-ctw", student_id: "student-a", logical_item_id: "ctw-a", task_type: "ctw", correct_points: 1, total_points: 2, elapsed_seconds: 120 }),
    attempt({ attempt_id: "a-rdl", student_id: "student-a", logical_item_id: "rdl-a", task_type: "rdl", correct_points: 1, total_points: 1, elapsed_seconds: 60 }),
    attempt({ attempt_id: "b-rap", student_id: "student-b", logical_item_id: "rap-a", task_type: "rap", correct_points: 2, total_points: 3, elapsed_seconds: 180 }),
    attempt({ attempt_id: "draft", student_id: "student-b", logical_item_id: "ctw-a", status: "draft", submitted_at: null })
  ],
  answers: [
    { attempt_id: "a-ctw", logical_item_id: "ctw-a", question_id: "q-ctw", slot_id: "slot-1", answer_kind: "ctw_slot", is_correct: true },
    { attempt_id: "a-ctw", logical_item_id: "ctw-a", question_id: "q-ctw", slot_id: "slot-2", answer_kind: "ctw_slot", is_correct: false },
    { attempt_id: "a-rdl", logical_item_id: "rdl-a", question_id: "q-rdl", slot_id: null, answer_kind: "option", is_correct: true },
    { attempt_id: "b-rap", logical_item_id: "rap-a", question_id: "q-rap-mc", slot_id: null, answer_kind: "option", is_correct: true },
    { attempt_id: "b-rap", logical_item_id: "rap-a", question_id: "q-rap-insert", slot_id: null, answer_kind: "insertion_anchor", is_correct: false },
    { attempt_id: "b-rap", logical_item_id: "rap-a", question_id: "q-rap-select", slot_id: null, answer_kind: "sentence_selection", is_correct: true }
  ],
  questions: [
    { question_id: "q-ctw", logical_item_id: "ctw-a", question_order: 1, module: "ctw", question_type: "ctw" },
    { question_id: "q-rdl", logical_item_id: "rdl-a", question_order: 1, module: "rdl", question_type: "rdl" },
    { question_id: "q-rap-mc", logical_item_id: "rap-a", question_order: 1, module: "rap", question_type: "rap_multiple_choice" },
    { question_id: "q-rap-insert", logical_item_id: "rap-a", question_order: 2, module: "rap", question_type: "rap_sentence_insertion" },
    { question_id: "q-rap-select", logical_item_id: "rap-a", question_order: 3, module: "rap", question_type: "rap_sentence_selection" }
  ],
  slots: [
    { question_id: "q-ctw", slot_id: "slot-1", slot_order: 1 },
    { question_id: "q-ctw", slot_id: "slot-2", slot_order: 2 }
  ]
};

test("Teacher Reading statistics count submitted attempts only", () => {
  const stats = buildTeacherReadingStats(statsInput);
  assert.equal(stats.overview.completedAttempts, 3);
  assert.equal(stats.students.find((row) => row.studentId === "student-b").completedAttempts, 1);
});

test("student summary includes accuracy, time, and CTW/RDL/RAP performance", () => {
  const stats = buildTeacherReadingStats(statsInput);
  const alpha = stats.students.find((row) => row.studentId === "student-a");
  assert.equal(alpha.completedAttempts, 2);
  assert.equal(alpha.accuracy, 2 / 3);
  assert.equal(alpha.totalPracticeSeconds, 180);
  assert.equal(alpha.byTask.ctw.completedAttempts, 1);
  assert.equal(alpha.byTask.rdl.accuracy, 1);
  assert.equal(alpha.byTask.rap.completedAttempts, 0);
});

test("logical item summary has attempt count, student count, average accuracy, and time", () => {
  const stats = buildTeacherReadingStats(statsInput);
  const rap = stats.items.find((row) => row.itemId === "rap-a");
  assert.deepEqual({ attempts: rap.attemptCount, students: rap.studentCount, accuracy: rap.averageAccuracy, time: rap.averageTimeSeconds }, { attempts: 1, students: 1, accuracy: 2 / 3, time: 180 });
});

test("question-level statistics preserve CTW slot IDs and RDL question IDs", () => {
  const stats = buildTeacherReadingStats(statsInput);
  assert.ok(stats.questions.some((row) => row.pointId === "q-ctw:slot-1" && row.displayName === "第 1 题" && row.accuracy === 1));
  assert.ok(stats.questions.some((row) => row.pointId === "q-rdl" && row.taskType === "rdl" && row.accuracy === 1));
});

test("RAP multiple choice, insertion, and sentence selection remain separate stable groups", () => {
  const stats = buildTeacherReadingStats(statsInput);
  const rap = stats.questions.filter((row) => row.taskType === "rap");
  assert.deepEqual(rap.map((row) => row.pointId), ["q-rap-mc", "q-rap-insert", "q-rap-select"]);
  assert.deepEqual(new Set(rap.map((row) => row.typeName)), new Set(["Multiple Choice", "Sentence Insertion", "Sentence Selection"]));
});

test("Teacher statistics enforce owned-student scope and never select answer keys", () => {
  assert.match(teacherRoute, /requireUserWithRole\(token, "teacher"\)/);
  assert.match(teacherRoute, /listVisibleStudentIds/);
  assert.match(teacherRoute, /studentIds/);
  assert.doesNotMatch(teacherRoute, /correct_option_id|correct_anchor_id|correct_sentence_id|missing_text|student_answer/);
});

test("Reading Catalog and Teacher Statistics reuse established shared UI", () => {
  assert.match(catalogUi, /PracticeSetCatalogList/);
  assert.match(catalogUi, /PracticeSetAction/);
  assert.match(teacherUi, /TeacherMetricCard/);
  assert.match(teacherUi, /TeacherCard/);
  assert.match(teacherUi, /TeacherAccuracyBar/);
  assert.doesNotMatch(studentShell + studentDashboard, /即将上线/);
});

test("Dashboard and Sidebar keep Writing purple while Reading uses the shared blue theme", () => {
  assert.match(studentDashboard, /theme="writing"/);
  assert.match(studentDashboard, /theme="reading"/);
  assert.match(studentDashboard, /theme === "reading"/);
  assert.match(studentDashboard, /text-\[#347fdc\]/);
  assert.match(studentShell, /section\.tone === "reading" \? "text-\[#347fdc\]" : "text-student-primary"/);
});

test("Complete the Words uses one shared rounded four-way icon on Dashboard and Sidebar", () => {
  assert.match(ctwIcon, /export const CompleteTheWordsIcon/);
  assert.equal((ctwIcon.match(/<rect/g) || []).length, 4);
  assert.match(studentDashboard, /icon: CompleteTheWordsIcon/);
  assert.match(studentShell, /icon: CompleteTheWordsIcon/);
  assert.doesNotMatch(studentDashboard + studentShell, /BookText/);
});

test("Reading Catalog starts directly after navigation and Dashboard uses resumable state", () => {
  assert.doesNotMatch(catalogUi, />Reading</);
  assert.doesNotMatch(catalogUi, /目录按最新内容优先显示/);
  assert.doesNotMatch(catalogUi, /<h1/);
  assert.match(studentDashboard, /summary\?\.readingProgress\.ctw/);
  assert.match(studentDashboard, /summary\?\.readingProgress\.rdl/);
  assert.match(studentDashboard, /summary\?\.readingProgress\.rap/);
  assert.match(studentDashboard, /canResume \? "继续练习" : "开始练习"/);
  assert.doesNotMatch(studentDashboard, /按历史首次出现顺序编号/);
});

test("Reading catalog invalidation also refreshes the cached Dashboard summary", () => {
  assert.match(studentDataCache, /keyPrefix\.startsWith\(STUDENT_READING_CATALOG_CACHE_PREFIX\)/);
  assert.match(studentDataCache, /\[keyPrefix, STUDENT_DASHBOARD_SUMMARY_CACHE_KEY\]/);
});
