const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  STUDENT_RANGE_DAY_COUNT_KEYS,
  firstSearchParamValue,
  formatStudentPracticeHistoryParams,
  isPracticeDateKey,
  parseStudentPracticeHistoryUrl,
  studentPracticeHistoryHref,
  studentPracticeRecordResultTarget,
  studentPracticeRecordRetakeTarget
} = require("../lib/studentPracticeHistory.ts");
const {
  loadStudentPracticeHistoryDay,
  loadStudentPracticeHistoryRange
} = require("../lib/studentPracticeHistory.server.ts");
const {
  buildTeacherStudentWritingPractice,
  TEACHER_PRACTICE_TASK_TYPES
} = require("../lib/teacherStudentPractice.ts");
const {
  buildTeacherStudentPracticeRange
} = require("../lib/teacherStudentPracticeRange.ts");
const { buildReadingCatalogPublicPayload } = require("../lib/reading/catalog.ts");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const TODAY = "2026-10-04";

function catalogLoaderFromRows(rows) {
  return async (taskType) => buildReadingCatalogPublicPayload({
    taskType,
    items: rows.filter((row) => row.module === taskType)
  });
}

function readingItem(overrides) {
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
    correct_points: 8,
    submitted_at: "2026-10-02T02:00:00.000Z",
    ...overrides
  };
}

function objectiveRecord(overrides) {
  return {
    recordId: "ctw:r-1",
    attemptId: "r-1",
    domain: "reading",
    taskType: "ctw",
    kind: "practice",
    title: "题目001 · Alpha",
    submittedAt: "2026-10-02T02:00:00.000Z",
    durationSeconds: 60,
    metric: { kind: "objective", correct: 8, total: 10, accuracy: 0.8 },
    scope: null,
    href: null,
    ...overrides
  };
}

function writingRecord(overrides) {
  return {
    recordId: "email:e-1",
    attemptId: "e-1",
    domain: "writing",
    taskType: "email",
    kind: "practice",
    title: "题目021 Request",
    submittedAt: "2026-10-02T03:00:00.000Z",
    durationSeconds: 300,
    metric: { kind: "writing", hasScore: false, score: null, wordCount: 180 },
    scope: null,
    href: null,
    source: { writingAssignmentId: null, writingQuestionId: "q-email-1" },
    ...overrides
  };
}

test("URL state restores the day, the task filter and the active range", () => {
  const base = parseStudentPracticeHistoryUrl({ today: TODAY });
  assert.equal(base.selectedDay, TODAY);
  assert.deepEqual(base.view, { kind: "day" });
  assert.equal(TEACHER_PRACTICE_TASK_TYPES.every((taskType) => base.tasks[taskType]), true);

  const day = parseStudentPracticeHistoryUrl({
    date: "2026-10-02",
    tasks: "ctw,rdl,full_set",
    today: TODAY
  });
  assert.equal(day.selectedDay, "2026-10-02");
  assert.deepEqual(day.view, { kind: "day" });
  assert.equal(day.tasks.ctw, true);
  assert.equal(day.tasks.rdl, true);
  assert.equal(day.tasks.full_set, true);
  assert.equal(day.tasks.rap, false);
  assert.equal(day.tasks.build_sentence, false);

  const range = parseStudentPracticeHistoryUrl({
    start: "2026-10-01",
    end: "2026-10-08",
    view: "range",
    today: TODAY
  });
  assert.deepEqual(range.view, { kind: "range", start: "2026-10-01", end: "2026-10-08" });
  assert.equal(range.selectedDay, "2026-10-01");

  const rangeDay = parseStudentPracticeHistoryUrl({
    date: "2026-10-03",
    start: "2026-10-01",
    end: "2026-10-08",
    today: TODAY
  });
  assert.deepEqual(rangeDay.view, {
    kind: "rangeDay",
    start: "2026-10-01",
    end: "2026-10-08",
    date: "2026-10-03"
  });
  assert.equal(rangeDay.selectedDay, "2026-10-03");

  // A single-day range collapses back to the single-day detail.
  const collapsed = parseStudentPracticeHistoryUrl({
    date: "2026-10-01",
    start: "2026-10-01",
    end: "2026-10-01",
    today: TODAY
  });
  assert.deepEqual(collapsed.view, { kind: "day" });

  // Invalid values never break the page.
  const invalid = parseStudentPracticeHistoryUrl({
    date: "not-a-date",
    end: "2026-10-08",
    start: "garbage",
    today: TODAY
  });
  assert.deepEqual(invalid.view, { kind: "day" });
  assert.equal(invalid.selectedDay, TODAY);
  assert.equal(isPracticeDateKey("2026-10-01"), true);
  assert.equal(isPracticeDateKey("2026-1-1"), false);
});

test("URL params round-trip the state and the untouched default stays clean", () => {
  const allTasks = parseStudentPracticeHistoryUrl({ today: TODAY }).tasks;
  assert.deepEqual(
    formatStudentPracticeHistoryParams({
      selectedDay: TODAY,
      tasks: allTasks,
      today: TODAY,
      view: { kind: "day" }
    }),
    { date: null, tasks: null, start: null, end: null, view: null }
  );
  assert.equal(
    studentPracticeHistoryHref({
      selectedDay: TODAY,
      tasks: allTasks,
      today: TODAY,
      view: { kind: "day" }
    }),
    "/student/practice-history"
  );

  const dayParams = formatStudentPracticeHistoryParams({
    selectedDay: "2026-10-02",
    tasks: { ...allTasks, rdl: false },
    today: TODAY,
    view: { kind: "day" }
  });
  assert.deepEqual(dayParams, {
    date: "2026-10-02",
    tasks: "ctw,rap,full_set,build_sentence,email,academic_discussion",
    start: null,
    end: null,
    view: null
  });
  const dayHref = studentPracticeHistoryHref({
    selectedDay: "2026-10-02",
    tasks: { ...allTasks, rdl: false },
    today: TODAY,
    view: { kind: "day" }
  });
  const restored = parseStudentPracticeHistoryUrl({
    ...Object.fromEntries(new URL(dayHref, "https://tps.local").searchParams),
    today: TODAY
  });
  assert.equal(restored.selectedDay, "2026-10-02");
  assert.equal(restored.tasks.rdl, false);
  assert.deepEqual(restored.view, { kind: "day" });

  const rangeParams = formatStudentPracticeHistoryParams({
    selectedDay: "2026-10-01",
    tasks: allTasks,
    today: TODAY,
    view: { kind: "range", start: "2026-10-01", end: "2026-10-08" }
  });
  assert.deepEqual(rangeParams, {
    date: "2026-10-01",
    tasks: null,
    start: "2026-10-01",
    end: "2026-10-08",
    view: "range"
  });

  const rangeDayParams = formatStudentPracticeHistoryParams({
    selectedDay: "2026-10-03",
    tasks: allTasks,
    today: TODAY,
    view: { kind: "rangeDay", start: "2026-10-01", end: "2026-10-08", date: "2026-10-03" }
  });
  assert.deepEqual(rangeDayParams, {
    date: "2026-10-03",
    tasks: null,
    start: "2026-10-01",
    end: "2026-10-08",
    view: null
  });
  const rangeDayHref = studentPracticeHistoryHref({
    selectedDay: "2026-10-03",
    tasks: allTasks,
    today: TODAY,
    view: { kind: "rangeDay", start: "2026-10-01", end: "2026-10-08", date: "2026-10-03" }
  });
  const restoredRangeDay = parseStudentPracticeHistoryUrl({
    ...Object.fromEntries(new URL(rangeDayHref, "https://tps.local").searchParams),
    today: TODAY
  });
  assert.deepEqual(restoredRangeDay.view, {
    kind: "rangeDay",
    start: "2026-10-01",
    end: "2026-10-08",
    date: "2026-10-03"
  });

  const none = parseStudentPracticeHistoryUrl({ tasks: "none", today: TODAY }).tasks;
  assert.equal(TEACHER_PRACTICE_TASK_TYPES.some((taskType) => none[taskType]), false);
  assert.equal(firstSearchParamValue(["2026-10-02", "ignored"]), "2026-10-02");
});

test("record result targets keep the existing student result pages and returnTo state", () => {
  const returnTo = "/student/practice-history?date=2026-10-02&tasks=ctw";
  const ctw = studentPracticeRecordResultTarget(objectiveRecord(), returnTo);
  assert.deepEqual(ctw, {
    href: "/student/reading/results/r-1?source=practice-history"
      + "&returnTo=%2Fstudent%2Fpractice-history%3Fdate%3D2026-10-02%26tasks%3Dctw",
    label: "查看结果"
  });

  const fullSet = studentPracticeRecordResultTarget(
    objectiveRecord({
      recordId: "full_set:fs-1",
      attemptId: "fs-1",
      kind: "full_set",
      taskType: "full_set",
      title: "Full Set 20261001",
      source: { fullSetId: "20261001" }
    }),
    returnTo
  );
  assert.match(fullSet.href, /^\/student\/reading\/full-sets\/20261001\/result\/fs-1\?source=practice-history/);
  assert.equal(fullSet.label, "查看结果");

  const bas = studentPracticeRecordResultTarget(
    objectiveRecord({
      recordId: "build_sentence:b-1",
      attemptId: "b-1",
      domain: "writing",
      taskType: "build_sentence",
      source: { basSetId: "set-1" }
    }),
    returnTo
  );
  assert.deepEqual(bas, {
    href: "/student/results/b-1?source=practice-history"
      + "&returnTo=%2Fstudent%2Fpractice-history%3Fdate%3D2026-10-02%26tasks%3Dctw",
    label: "查看结果"
  });

  const published = studentPracticeRecordResultTarget(
    writingRecord({
      metric: { kind: "writing", hasScore: true, score: 4, wordCount: 180 }
    }),
    returnTo
  );
  assert.equal(published.label, "查看批改");
  assert.match(published.href, /^\/student\/writing-reviews\/e-1\?returnTo=/);

  const submitted = studentPracticeRecordResultTarget(writingRecord(), returnTo);
  assert.equal(submitted.label, "查看提交");
  assert.match(submitted.href, /^\/student\/write-email\/submission\/e-1\?returnTo=/);

  // Wrong-question records never open a result from the student history.
  const wrongbook = studentPracticeRecordResultTarget(
    objectiveRecord({ kind: "wrongbook", scope: "today" }),
    returnTo
  );
  assert.equal(wrongbook, null);
});

test("record retake targets reuse the existing retake entries", () => {
  assert.deepEqual(studentPracticeRecordRetakeTarget(objectiveRecord()), {
    kind: "reading",
    attemptId: "r-1"
  });
  assert.deepEqual(
    studentPracticeRecordRetakeTarget(objectiveRecord({
      kind: "full_set",
      taskType: "full_set",
      source: { fullSetId: "20261001" }
    })),
    { kind: "full_set", fullSetId: "20261001" }
  );
  assert.deepEqual(
    studentPracticeRecordRetakeTarget(objectiveRecord({
      domain: "writing",
      taskType: "build_sentence",
      source: { basSetId: "set-1" }
    })),
    { kind: "link", href: "/student/practice/set-1", label: "重新练习" }
  );
  assert.deepEqual(
    studentPracticeRecordRetakeTarget(writingRecord()),
    { kind: "link", href: "/student/write-email/practice/q-email-1?new=1", label: "重新练习" }
  );
  assert.deepEqual(
    studentPracticeRecordRetakeTarget(writingRecord({
      taskType: "academic_discussion",
      source: { writingAssignmentId: "a-1", writingQuestionId: "q-1" }
    })),
    { kind: "link", href: "/student/assignments/a-1?new=1", label: "重新练习" }
  );
  assert.equal(
    studentPracticeRecordRetakeTarget(objectiveRecord({ kind: "wrongbook" })),
    null
  );
});

test("student scope keeps the seven task types and excludes every virtual BAS set", () => {
  const practice = buildTeacherStudentWritingPractice({
    basAttempts: [
      {
        attempt_id: "b-official",
        set_id: "set-1",
        set_title: "旧题名",
        correct_count: 8,
        total_questions: 10,
        time_spent_seconds: 120,
        submitted_at: "2026-10-02T02:00:00.000Z"
      },
      {
        attempt_id: "b-wrongbook",
        set_id: "wrongbook-today-20261002",
        set_title: "错题订正",
        correct_count: 1,
        total_questions: 1,
        time_spent_seconds: 10,
        submitted_at: "2026-10-02T03:00:00.000Z"
      },
      {
        attempt_id: "b-grammar",
        set_id: "grammar-random-1",
        set_title: "语法练习",
        correct_count: 3,
        total_questions: 5,
        time_spent_seconds: 60,
        submitted_at: "2026-10-02T04:00:00.000Z"
      }
    ],
    basTitles: new Map([["set-1", "套题031"]]),
    includeVirtualBas: false,
    studentId: "student-1",
    writingAttempts: [],
    writingDisplayNames: new Map()
  });

  assert.equal(practice.tasks.build_sentence.attempts, 1);
  assert.equal(practice.tasks.build_sentence.correctCount, 8);
  assert.deepEqual(practice.records.map((record) => record.attemptId), ["b-official"]);
  assert.deepEqual(practice.records[0].source, { basSetId: "set-1" });
  assert.equal(JSON.stringify(practice).includes("wrongbook"), false);
  assert.equal(JSON.stringify(practice).includes("grammar"), false);

  // Default (teacher) behavior is untouched: wrongbook keeps its record and the
  // legacy grammar set still counts as BAS practice.
  const teacher = buildTeacherStudentWritingPractice({
    basAttempts: [
      {
        attempt_id: "b-wrongbook",
        set_id: "wrongbook-today-20261002",
        set_title: "错题订正",
        correct_count: 1,
        total_questions: 1,
        time_spent_seconds: 10,
        submitted_at: "2026-10-02T03:00:00.000Z"
      },
      {
        attempt_id: "b-grammar",
        set_id: "grammar-random-1",
        set_title: "语法练习",
        correct_count: 3,
        total_questions: 5,
        time_spent_seconds: 60,
        submitted_at: "2026-10-02T04:00:00.000Z"
      }
    ],
    studentId: "student-1",
    writingAttempts: [],
    writingDisplayNames: new Map()
  });
  assert.equal(teacher.records.length, 2);
  assert.equal(teacher.tasks.build_sentence.attempts, 1);
});

test("student range keeps seven-type days only, teacher range keeps wrongbook days", () => {
  const reading = {
    attempts: [
      readingAttempt({ attempt_id: "r-1", submitted_at: "2026-10-02T02:00:00.000Z" })
    ],
    wrongbookAttempts: [
      {
        attempt_id: "w-entry",
        status: "submitted",
        submitted_at: "2026-10-03T03:00:00.000Z"
      }
    ],
    sessions: [],
    fullSetAttempts: [],
    fullSetModules: []
  };
  const writing = {
    basAttempts: [
      {
        set_id: "wrongbook-today-20261004",
        set_title: "今日错题订正",
        correct_count: 1,
        total_questions: 5,
        submitted_at: "2026-10-04T04:00:00.000Z"
      }
    ],
    writingAttempts: []
  };

  const studentRange = buildTeacherStudentPracticeRange({
    includeWrongbook: false,
    includeVirtualBas: false,
    reading,
    timeZone: "Asia/Shanghai",
    writing
  });
  assert.deepEqual(studentRange.days.map((day) => day.date), ["2026-10-02"]);
  for (const key of ["wrongbook_entry", "wrongbook_today", "wrongbook_history"]) {
    assert.equal(studentRange.days[0].counts[key], 0);
  }
  assert.equal(studentRange.days[0].counts.ctw, 1);
  assert.equal(studentRange.reading.tasks.ctw.attempts, 1);

  const teacherRange = buildTeacherStudentPracticeRange({
    reading,
    timeZone: "Asia/Shanghai",
    writing
  });
  assert.deepEqual(
    teacherRange.days.map((day) => day.date),
    ["2026-10-04", "2026-10-03", "2026-10-02"]
  );
  const wrongbookDay = teacherRange.days.find((day) => day.date === "2026-10-03");
  assert.equal(wrongbookDay.counts.wrongbook_entry, 1);

  assert.deepEqual(
    STUDENT_RANGE_DAY_COUNT_KEYS,
    ["ctw", "rdl", "rap", "full_set", "build_sentence", "email", "academic_discussion"]
  );
});

test("student day loader reads only the requested day and the authenticated student", async () => {
  const rows = [readingItem()];
  const db = createMockSupabase({
    academic_discussion_questions: [],
    attempts: [
      {
        attempt_id: "b-mine",
        student_id: "student-1",
        set_id: "set-1",
        set_title: "套题031",
        correct_count: 8,
        total_questions: 10,
        time_spent_seconds: 100,
        submitted_at: "2026-10-02T02:00:00.000Z"
      },
      {
        attempt_id: "b-wrongbook",
        student_id: "student-1",
        set_id: "wrongbook-today-20261002",
        set_title: "错题订正",
        correct_count: 1,
        total_questions: 1,
        time_spent_seconds: 10,
        submitted_at: "2026-10-02T03:00:00.000Z"
      },
      {
        attempt_id: "b-other-student",
        student_id: "student-2",
        set_id: "set-1",
        set_title: "套题031",
        correct_count: 10,
        total_questions: 10,
        time_spent_seconds: 90,
        submitted_at: "2026-10-02T02:30:00.000Z"
      },
      {
        attempt_id: "b-other-day",
        student_id: "student-1",
        set_id: "set-1",
        set_title: "套题031",
        correct_count: 5,
        total_questions: 10,
        time_spent_seconds: 80,
        submitted_at: "2026-10-03T02:00:00.000Z"
      }
    ],
    email_questions: [],
    reading_attempts: [
      readingAttempt({ attempt_id: "r-mine" }),
      readingAttempt({
        attempt_id: "r-other-student",
        student_id: "student-2",
        submitted_at: "2026-10-02T02:10:00.000Z"
      }),
      readingAttempt({
        attempt_id: "r-other-day",
        submitted_at: "2026-10-03T02:00:00.000Z"
      })
    ],
    reading_full_set_attempts: [],
    reading_logical_items: rows,
    writing_assignments: [],
    writing_attempts: [],
    writing_reviews: []
  });
  const forbidden = new Set([
    "reading_wrongbook_attempts",
    "student_wrong_question_sessions"
  ]);
  const originalFrom = db.from.bind(db);
  db.from = (table) => {
    if (forbidden.has(table)) throw new Error(`student scope must not query ${table}`);
    return originalFrom(table);
  };

  const payload = await loadStudentPracticeHistoryDay(
    db,
    "student-1",
    "2026-10-02T00:00:00.000Z",
    "2026-10-03T00:00:00.000Z",
    catalogLoaderFromRows(rows)
  );

  assert.deepEqual(payload.reading.records.map((record) => record.attemptId), ["r-mine"]);
  assert.deepEqual(payload.writing.records.map((record) => record.attemptId), ["b-mine"]);
  assert.equal(payload.reading.tasks.ctw.attempts, 1);
  assert.equal(payload.writing.tasks.build_sentence.attempts, 1);
  assert.deepEqual(payload.writing.records[0].source, { basSetId: "set-1" });
  assert.deepEqual(payload.range, {
    startAt: "2026-10-02T00:00:00.000Z",
    endAt: "2026-10-03T00:00:00.000Z"
  });
  assert.equal(JSON.stringify(payload).includes("wrongbook"), false);
  assert.equal(JSON.stringify(payload).includes("student-2"), false);
  assert.equal(JSON.stringify(payload).includes("b-other-day"), false);
});

test("student day loader resolves published writing scores and full set sources", async () => {
  const rows = [
    readingItem({ logical_item_id: "ctw-fs", scored_item_count: 1 })
  ];
  const db = createMockSupabase({
    academic_discussion_questions: [],
    attempts: [],
    email_questions: [],
    reading_attempts: [],
    reading_full_set_answers: [
      {
        module_attempt_id: "m1",
        occurrence_id: "o1",
        logical_item_id: "ctw-fs",
        is_correct: true
      },
      {
        module_attempt_id: "m2",
        occurrence_id: "o2",
        logical_item_id: "ctw-fs",
        is_correct: false
      }
    ],
    reading_full_set_attempts: [
      { attempt_id: "fs-1", student_id: "student-1", full_set_id: "20261001", status: "completed", completed_at: "2026-10-02T05:00:00.000Z" }
    ],
    reading_full_set_module_attempts: [
      {
        attempt_id: "fs-1",
        module_attempt_id: "m1",
        module_number: 1,
        status: "submitted",
        started_at: "2026-10-02T04:00:00.000Z",
        submitted_at: "2026-10-02T04:18:00.000Z",
        time_limit_seconds: 1230
      },
      {
        attempt_id: "fs-1",
        module_attempt_id: "m2",
        module_number: 2,
        status: "submitted",
        started_at: "2026-10-02T04:18:00.000Z",
        submitted_at: "2026-10-02T04:26:00.000Z",
        time_limit_seconds: 540
      }
    ],
    reading_logical_items: rows,
    writing_assignments: [],
    writing_attempts: [
      {
        attempt_id: "e-1",
        user_id: "student-1",
        assignment_id: null,
        task_type: "email",
        question_id: "q-1",
        word_count: 180,
        elapsed_seconds: 300,
        status: "submitted",
        submitted_at: "2026-10-02T03:00:00.000Z"
      }
    ],
    writing_reviews: [
      {
        attempt_id: "e-1",
        status: "published",
        published_at: "2026-10-03T00:00:00.000Z",
        official_score: 4
      }
    ]
  });

  const payload = await loadStudentPracticeHistoryDay(
    db,
    "student-1",
    "2026-10-02T00:00:00.000Z",
    "2026-10-03T00:00:00.000Z",
    catalogLoaderFromRows(rows)
  );

  const fullSet = payload.reading.records.find((record) => record.kind === "full_set");
  assert.equal(fullSet.recordId, "full_set:fs-1");
  assert.deepEqual(fullSet.source, { fullSetId: "20261001" });
  assert.equal(fullSet.metric.correct, 1);
  assert.equal(fullSet.metric.total, 2);
  assert.equal(payload.reading.fullSet.attempts, 1);

  const email = payload.writing.records.find((record) => record.attemptId === "e-1");
  assert.equal(email.metric.hasScore, true);
  assert.equal(email.metric.score, 4);
  assert.deepEqual(email.source, { writingAssignmentId: null, writingQuestionId: "q-1" });
  assert.equal(payload.writing.tasks.email.scoredAttempts, 1);
});

test("student range loader never touches wrong-question or content tables", async () => {
  const db = createMockSupabase({
    attempts: [
      {
        attempt_id: "b-1",
        student_id: "student-1",
        set_id: "set-1",
        set_title: "套题031",
        correct_count: 8,
        total_questions: 10,
        submitted_at: "2026-10-02T02:00:00.000Z"
      },
      {
        attempt_id: "b-wrongbook",
        student_id: "student-1",
        set_id: "wrongbook-today-20261002",
        set_title: "错题订正",
        correct_count: 1,
        total_questions: 1,
        submitted_at: "2026-10-02T03:00:00.000Z"
      }
    ],
    reading_attempts: [
      {
        attempt_id: "r-1",
        student_id: "student-1",
        task_type: "ctw",
        status: "submitted",
        correct_points: 8,
        total_points: 10,
        submitted_at: "2026-10-02T02:00:00.000Z"
      }
    ],
    reading_full_set_attempts: [],
    writing_attempts: [
      {
        attempt_id: "e-1",
        user_id: "student-1",
        task_type: "email",
        status: "submitted",
        submitted_at: "2026-10-02T04:00:00.000Z"
      }
    ],
    writing_reviews: []
  });
  const forbidden = new Set([
    "reading_wrongbook_attempts",
    "student_wrong_question_sessions",
    "reading_full_set_answers"
  ]);
  const originalFrom = db.from.bind(db);
  db.from = (table) => {
    if (forbidden.has(table)) throw new Error(`student scope must not query ${table}`);
    return originalFrom(table);
  };

  const payload = await loadStudentPracticeHistoryRange(
    db,
    "student-1",
    "2026-10-02T00:00:00.000Z",
    "2026-10-03T00:00:00.000Z",
    "Asia/Shanghai"
  );

  assert.equal(payload.reading.tasks.ctw.attempts, 1);
  assert.equal(payload.writing.tasks.build_sentence.attempts, 1);
  assert.equal(payload.writing.tasks.email.attempts, 1);
  assert.deepEqual(payload.days.map((day) => day.date), ["2026-10-02"]);
  const day = payload.days[0];
  assert.equal(day.counts.ctw, 1);
  assert.equal(day.counts.build_sentence, 1);
  assert.equal(day.counts.email, 1);
  assert.equal(day.counts.wrongbook_entry, 0);
  assert.equal(day.counts.wrongbook_today, 0);
  assert.equal(
    payload.days.every((entry) =>
      entry.counts.wrongbook_entry
        + entry.counts.wrongbook_today
        + entry.counts.wrongbook_history === 0
    ),
    true
  );
});

test("student API routes are session-scoped and reuse the shared loaders", () => {
  const dayRoute = read("app/api/student/practice-history/route.ts");
  assert.match(dayRoute, /requireUserWithRole\(bearerToken\(request\), "student"\)/);
  assert.match(dayRoute, /loadStudentPracticeHistoryDay\(/);
  assert.match(dayRoute, /loadCachedPublicReadingCatalog/);
  assert.match(dayRoute, /auth\.userId/);
  assert.match(dayRoute, /startAt/);
  assert.match(dayRoute, /endAt/);
  assert.doesNotMatch(dayRoute, /requireTeacherOnly|loadTeacherScope|studentId/);
  assert.doesNotMatch(dayRoute, /listVisibleStudentIds/);

  const rangeRoute = read("app/api/student/practice-history/range/route.ts");
  assert.match(rangeRoute, /requireUserWithRole\(bearerToken\(request\), "student"\)/);
  assert.match(rangeRoute, /loadStudentPracticeHistoryRange\(/);
  assert.match(rangeRoute, /normalizePracticeTimeZone/);
  assert.match(rangeRoute, /auth\.userId/);
  assert.doesNotMatch(rangeRoute, /requireTeacherOnly|loadTeacherScope|studentId/);
  assert.doesNotMatch(rangeRoute, /loadTeacherStudentReadingPractice|loadTeacherStudentWritingPractice/);

  const helper = read("lib/studentPracticeHistory.server.ts");
  assert.match(helper, /includeWrongbook: false/);
  assert.match(helper, /includeVirtualBas: false/);
  assert.match(helper, /loadTeacherStudentReadingPractice\(/);
  assert.match(helper, /loadTeacherStudentWritingPractice\(/);
  assert.match(helper, /loadTeacherStudentPracticeRange\(/);
  assert.doesNotMatch(helper, /studentId.*searchParams|params\.studentId/);

  // The scoped range loader skips the wrong-question queries entirely.
  const rangeLoader = read("lib/teacherStudentPracticeRange.server.ts");
  assert.match(
    rangeLoader,
    /includeWrongbook\s*\?\s*readAllSupabaseRows<TeacherRangeWrongbookAttemptRow>/
  );
  assert.match(
    rangeLoader,
    /includeWrongbook\s*\?\s*readAllSupabaseRows<TeacherRangeWrongbookSessionRow>/
  );
  // The scoped day loader skips the wrongbook attempt plus session queries.
  const dayLoader = read("lib/teacherStudentPractice.server.ts");
  assert.match(dayLoader, /includeWrongbook[\s\S]{0,80}\? readAllSupabaseRows<TeacherReadingWrongbookAttemptRow>/);
  assert.match(dayLoader, /wrongbookTaskTypes = includeWrongbook/);
});

test("student page replaces the full-history scan with day / range loads only", () => {
  const page = read("app/student/practice-history/page.tsx");
  assert.match(page, /<StudentPracticeHistory/);
  assert.match(page, /initialDate=\{firstSearchParamValue\(searchParams\?\.date\)\}/);
  assert.match(page, /initialTasks=\{firstSearchParamValue\(searchParams\?\.tasks\)\}/);
  assert.match(page, /initialStart=\{firstSearchParamValue\(searchParams\?\.start\)\}/);
  assert.match(page, /initialEnd=\{firstSearchParamValue\(searchParams\?\.end\)\}/);
  assert.match(page, /initialView=\{firstSearchParamValue\(searchParams\?\.view\)\}/);

  const component = read("components/student/StudentPracticeHistory.tsx");
  assert.doesNotMatch(component, /api\/unified-practice-history/);
  assert.doesNotMatch(component, /累计完成|累计用时|OverviewCards/);
  // Day cache key is the exact day window; range key is the date pair.
  assert.match(component, /STUDENT_PRACTICE_HISTORY_CACHE_PREFIX/);
  assert.match(component, /:day:\$\{range\.startAt\}:\$\{range\.endAt\}/);
  assert.match(component, /:range:\$\{rangeStartKey\}:\$\{rangeEndKey\}/);
  // Only the day view requests a day, and the range only after a range pick.
  assert.match(component, /const dayEnabled = view\.kind !== "range"/);
  assert.match(component, /enabled: dayEnabled/);
  assert.match(component, /enabled: Boolean\(rangeStartKey && rangeEndKey\)/);
  // Checkbox filtering works on the already loaded records.
  assert.match(component, /filterRecords\(dayPayload\?\.reading\?\.records \?\? \[\], selectedTasks\)/);
  assert.match(component, /filterRecords\(dayPayload\?\.writing\?\.records \?\? \[\], selectedTasks\)/);
  assert.match(component, /TEACHER_PRACTICE_TASK_TYPES\.map/);
  assert.match(component, /type="checkbox"/);
  // Date navigation and range picker.
  assert.match(component, /上一天/);
  assert.match(component, /下一天/);
  assert.match(component, />\s*今天\s*</);
  assert.match(component, /type="date"/);
  assert.match(component, /查看当天/);
  assert.match(component, /查看范围统计/);
  assert.match(component, /返回范围统计/);
  // Result links keep source + the exact returnTo state; retakes reuse the
  // existing student entries.
  assert.match(component, /studentPracticeRecordResultTarget\(record, returnTo\)/);
  assert.match(component, /studentPracticeRecordRetakeTarget\(record\)/);
  assert.match(component, /<ReadingRetakeButton attemptId=\{retake\.attemptId\} compact label="重新练习" \/>/);
  assert.match(component, /<ReadingFullSetRetakeButton compact fullSetId=\{retake\.fullSetId\} \/>/);
  // Sidebar-adapted layout grids.
  assert.match(component, /const READING_CARDS_GRID = "grid gap-4 sm:grid-cols-2 min-\[1280px\]:grid-cols-4"/);
  assert.match(component, /const WRITING_CARDS_GRID = "grid gap-4 sm:grid-cols-2 lg:grid-cols-3"/);
  assert.match(component, /grid grid-cols-4 gap-x-3 gap-y-1 sm:grid-cols-7/);
});

test("the old full-history page, API and build are gone", () => {
  for (const removed of [
    "components/UnifiedPracticeHistory.tsx",
    "app/api/unified-practice-history/route.ts",
    "lib/unifiedPracticeHistory.ts"
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, removed)), false, `${removed} must be removed`);
  }
  const shell = read("components/student/StudentShell.tsx");
  assert.match(shell, /isPracticeHistoryResult\(path, searchParams\)/);
  assert.match(shell, /searchParams\.get\("source"\)\?\.startsWith\("practice-history"\)/);
  const redirectPage = read("app/student/reading/history/page.tsx");
  assert.match(redirectPage, /redirect\(STUDENT_ROUTES\.practiceHistory\)/);
});

test("teacher practice reads keep their default scope", () => {
  const readingLoader = read("lib/teacherStudentPractice.server.ts");
  assert.match(readingLoader, /scope\?\.includeWrongbook !== false/);
  const rangeLoader = read("lib/teacherStudentPracticeRange.server.ts");
  assert.match(rangeLoader, /scope\?\.includeWrongbook !== false/);
  assert.match(rangeLoader, /includeVirtualBas: scope\?\.includeVirtualBas !== false/);
  const teacherRoute = read("app/api/teacher/students/[studentId]/practice/route.ts");
  assert.match(teacherRoute, /requireTeacherOnly\(bearerToken\(request\)\)/);
  assert.match(teacherRoute, /loadTeacherScope/);
});
