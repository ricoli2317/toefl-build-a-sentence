const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  TEACHER_PRACTICE_TASK_SHORT_LABELS,
  buildTeacherStudentReadingPractice,
  buildTeacherStudentWritingPractice,
  resolveTeacherWritingAttemptDisplayName
} = require("../lib/teacherStudentPractice.ts");
const {
  createHistoricalPracticeDisplayResolver
} = require("../lib/historicalPracticeDisplay.ts");
const { loadTeacherReadingItemMeta } = require("../lib/teacherStudentPractice.server.ts");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function readingItem(overrides) {
  return {
    logical_item_id: "ctw-a",
    module: "ctw",
    displayName: "套题001",
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
  ["ctw-b", readingItem({ logical_item_id: "ctw-b", displayName: "套题002" })],
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
  const wrongbook = practice.records.find((record) => record.attemptId === "w-1");
  assert.equal(wrongbook.kind, "wrongbook");
  assert.equal(wrongbook.scope, "today");
  assert.equal(wrongbook.taskType, "rdl");
});

test("Reading Full Set splits scoring points and practice units back into CTW/RDL/RAP", () => {
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

  assert.equal(practice.tasks.ctw.attempts, 2);
  assert.equal(practice.tasks.ctw.correctPoints, 17);
  assert.equal(practice.tasks.ctw.totalPoints, 20);
  assert.equal(practice.tasks.rdl.attempts, 1);
  assert.equal(practice.tasks.rdl.correctPoints, 2);
  assert.equal(practice.tasks.rdl.totalPoints, 2);
  assert.equal(practice.tasks.rap.attempts, 1);
  assert.equal(practice.tasks.rap.correctPoints, 3);
  assert.equal(practice.tasks.rap.totalPoints, 5);

  const fullSetRecords = practice.records.filter((record) => record.kind === "full_set");
  assert.deepEqual(
    fullSetRecords.map((record) => record.taskType).sort(),
    ["ctw", "rap", "rdl"]
  );
  const ctwRecord = fullSetRecords.find((record) => record.taskType === "ctw");
  assert.equal(ctwRecord.metric.correct, 17);
  assert.equal(ctwRecord.metric.total, 20);
  assert.equal(ctwRecord.durationSeconds, 18 * 60 + 8 * 60);

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
  assert.equal(practice.records.length, 0);
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
  assert.equal(official.href, "/teacher/students/student-1/details/set-1");
  const wrongbook = practice.records.find((record) => record.attemptId === "b-wrongbook");
  assert.equal(wrongbook.kind, "wrongbook");
  assert.equal(wrongbook.scope, "today");
  assert.equal(wrongbook.title, "今日错题");
  assert.equal(wrongbook.href, "/teacher/students/student-1/details/wrongbook-today");
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

test("scoped Reading metadata keeps the global display numbers without loading the whole catalog", async () => {
  const db = createMockSupabase({
    reading_logical_items: [
      readingCatalogRow({ logical_item_id: "ctw-a", first_seen_date: "2026-01-01", first_seen_source_order: 1 }),
      readingCatalogRow({ logical_item_id: "ctw-b", first_seen_date: "2026-01-01", first_seen_source_order: 2 }),
      readingCatalogRow({ logical_item_id: "ctw-c", first_seen_date: "2026-01-05", first_seen_source_order: 1 }),
      readingCatalogRow({ logical_item_id: "ctw-d", first_seen_date: "2026-02-01", first_seen_source_order: 1 }),
      readingCatalogRow({ logical_item_id: "ctw-e", first_seen_date: "2026-02-01", first_seen_source_order: 2 }),
      readingCatalogRow({ logical_item_id: "rdl-x", module: "rdl", title: "Library Notice", first_seen_date: "2026-01-02" })
    ]
  });

  const meta = await loadTeacherReadingItemMeta(db, ["ctw-b", "ctw-d"]);

  assert.equal(meta.size, 2);
  assert.equal(meta.get("ctw-b").displayName, "套题002");
  assert.equal(meta.get("ctw-d").displayName, "套题004");
  assert.equal(meta.get("ctw-d").scoringPointCount, 10);
});

test("checkbox short labels match the product copy", () => {  assert.deepEqual(TEACHER_PRACTICE_TASK_SHORT_LABELS, {
    ctw: "CTW",
    rdl: "RDL",
    rap: "RAP",
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
  assert.match(route, /canAccessStudentDomain\(db, actor, studentId, "reading"\)/);
  assert.match(route, /canAccessStudentDomain\(db, actor, studentId, "writing"\)/);
  assert.match(route, /if \(!readingAllowed && !writingAllowed\)/);
  assert.match(route, /parseDateBoundary/);
  assert.match(route, /loadTeacherStudentReadingPractice\(db, studentId, startAt, endAt\)/);
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
});

test("BAS drill-down routes are scoped to one student and one set or answer", () => {
  const setRoute = read("app/api/teacher/students/[studentId]/bas/sets/[setId]/route.ts");
  assert.match(setRoute, /canAccessStudentDomain\(db, \{ userId: auth.userId, role: auth.role \}, studentId, "writing"\)/);
  assert.match(setRoute, /loadTeacherStudentBasSet\(db, studentId, requestedSetId\)/);

  const answerRoute = read("app/api/teacher/students/[studentId]/answers/[attemptAnswerId]/route.ts");
  assert.match(answerRoute, /canAccessStudentDomain\(db, \{ userId: auth.userId, role: auth.role \}, studentId, "writing"\)/);
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

  const ui = read("components/teacher/TeacherUI.tsx");
  assert.match(ui, /tone === "reading" && "bg-\[#eef6ff\] text-\[#347fdc\]"/);
  assert.match(ui, /tone === "primary" && "bg-student-primary-soft text-student-primary"/);
});

test("both domains render through the same record list component", () => {
  const component = read("components/teacher/TeacherStudentPracticeSection.tsx");
  const listUsages = component.match(/<TeacherPracticeRecordList/g) ?? [];
  assert.equal(listUsages.length, 2);
  assert.match(component, /export function TeacherPracticeRecordList/);
  assert.match(component, /错题订正/);
});
