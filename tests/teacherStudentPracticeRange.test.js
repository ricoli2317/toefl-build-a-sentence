const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  basAttemptCategory,
  buildTeacherStudentPracticeRange,
  emptyPracticeRangeDayCounts,
  practiceRangeDateKey
} = require("../lib/teacherStudentPracticeRange.ts");
const {
  buildTeacherStudentReadingPractice,
  buildTeacherStudentWritingPractice
} = require("../lib/teacherStudentPractice.ts");

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

const ITEM_META = new Map([
  ["ctw-a", readingItem()],
  ["rdl-a", readingItem({
    logical_item_id: "rdl-a",
    module: "rdl",
    displayName: "题目002",
    scoringPointCount: 2
  })],
  ["rap-a", readingItem({
    logical_item_id: "rap-a",
    module: "rap",
    displayName: "题目003",
    scoringPointCount: 5
  })]
]);

function readingAttempt(overrides) {
  return {
    attempt_id: "r-1",
    logical_item_id: "ctw-a",
    task_type: "ctw",
    status: "submitted",
    elapsed_seconds: 60,
    total_points: 10,
    correct_points: 1,
    submitted_at: "2026-10-01T02:00:00.000Z",
    ...overrides
  };
}

function pointRows(moduleId, occurrenceId, logicalItemId, correct, incorrect) {
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

const FULL_SET_ANSWERS = [
  ...pointRows("m1", "m1-ctw", "ctw-a", 7, 3),
  ...pointRows("m1", "m1-rdl", "rdl-a", 2, 0),
  ...pointRows("m2", "m2-rap", "rap-a", 3, 2)
];

const FULL_SET_DAY_ROWS = {
  fullSetAttempts: [
    { attempt_id: "fs-1", full_set_id: "20261001", completed_at: "2026-10-01T05:00:00.000Z" }
  ],
  fullSetModules: [
    {
      attempt_id: "fs-1",
      module_attempt_id: "m1",
      module_number: 1,
      started_at: "2026-10-01T04:00:00.000Z",
      submitted_at: "2026-10-01T04:18:00.000Z",
      time_limit_seconds: 1230
    },
    {
      attempt_id: "fs-1",
      module_attempt_id: "m2",
      module_number: 2,
      started_at: "2026-10-01T04:18:00.000Z",
      submitted_at: "2026-10-01T04:26:00.000Z",
      time_limit_seconds: 540
    }
  ],
  fullSetAnswers: FULL_SET_ANSWERS
};

const FULL_SET_RANGE_ROWS = {
  fullSetAttempts: [
    { attempt_id: "fs-1", completed_at: "2026-10-01T05:00:00.000Z" }
  ],
  // The stored module grading points: m1 9/12 + m2 3/5 = 12/17, identical to
  // the single-day occurrence aggregation above.
  fullSetModules: [
    { attempt_id: "fs-1", module_attempt_id: "m1", correct_points: 9, total_points: 12 },
    { attempt_id: "fs-1", module_attempt_id: "m2", correct_points: 3, total_points: 5 }
  ]
};

test("range cards match the single-day card numbers exactly", () => {
  const dayAttempts = [
    readingAttempt({ attempt_id: "r-ctw", task_type: "ctw", correct_points: 8, total_points: 10 }),
    readingAttempt({
      attempt_id: "r-rdl",
      logical_item_id: "rdl-a",
      task_type: "rdl",
      correct_points: 1,
      total_points: 2
    }),
    readingAttempt({
      attempt_id: "r-rap",
      logical_item_id: "rap-a",
      task_type: "rap",
      correct_points: 3,
      total_points: 5
    })
  ];
  const day = buildTeacherStudentReadingPractice({
    attempts: dayAttempts,
    ...FULL_SET_DAY_ROWS,
    itemMeta: ITEM_META
  });
  const range = buildTeacherStudentPracticeRange({
    reading: {
      attempts: dayAttempts,
      wrongbookAttempts: [],
      sessions: [],
      ...FULL_SET_RANGE_ROWS
    },
    timeZone: "Asia/Shanghai"
  });

  assert.deepEqual(range.reading.tasks, day.tasks);
  assert.deepEqual(range.reading.fullSet, day.fullSet);
  assert.equal(range.reading.fullSet.attempts, 1);
  assert.equal(range.reading.fullSet.correctPoints, 12);
  assert.equal(range.reading.fullSet.totalPoints, 17);
  assert.equal(range.reading.fullSet.accuracy, 12 / 17);

  // The Full Set never inflates the single-task cards.
  assert.equal(range.reading.tasks.ctw.attempts, 1);
  assert.equal(range.reading.tasks.ctw.correctPoints, 8);
  assert.equal(range.reading.tasks.rdl.attempts, 1);
  assert.equal(range.reading.tasks.rap.attempts, 1);
});

test("range cards reuse the single-day BAS and WE/AD rules", () => {
  const basAttempts = [
    {
      attempt_id: "b-1",
      set_id: "set-1",
      set_title: "套题031",
      correct_count: 8,
      total_questions: 10,
      submitted_at: "2026-10-01T02:00:00.000Z"
    },
    {
      attempt_id: "b-2",
      set_id: "set-1",
      set_title: "套题031",
      correct_count: 6,
      total_questions: 10,
      submitted_at: "2026-10-01T03:00:00.000Z"
    },
    {
      attempt_id: "b-wrongbook",
      set_id: "wrongbook-today-20261001",
      set_title: "今日错题订正",
      correct_count: 1,
      total_questions: 1,
      submitted_at: "2026-10-01T04:00:00.000Z"
    }
  ];
  const writingAttempts = [
    {
      attempt_id: "e-1",
      task_type: "email",
      submitted_at: "2026-10-01T05:00:00.000Z"
    },
    {
      attempt_id: "e-2",
      task_type: "email",
      submitted_at: "2026-10-01T06:00:00.000Z"
    },
    {
      attempt_id: "a-1",
      task_type: "academic_discussion",
      submitted_at: "2026-10-02T05:00:00.000Z"
    }
  ];
  const reviewScores = new Map([["e-1", 4]]);
  const day = buildTeacherStudentWritingPractice({
    basAttempts,
    studentId: "student-1",
    writingAttempts,
    writingDisplayNames: new Map(),
    reviewScores
  });
  const range = buildTeacherStudentPracticeRange({
    writing: { basAttempts, writingAttempts, reviewScores },
    timeZone: "Asia/Shanghai"
  });

  assert.deepEqual(range.writing.tasks, day.tasks);
  assert.equal(range.writing.tasks.build_sentence.attempts, 2);
  assert.equal(range.writing.tasks.build_sentence.correctCount, 14);
  assert.equal(range.writing.tasks.build_sentence.totalQuestions, 20);
  assert.equal(range.writing.tasks.build_sentence.accuracy, 0.7);
  assert.equal(range.writing.tasks.email.attempts, 2);
  assert.equal(range.writing.tasks.email.scoredAttempts, 1);
  assert.equal(range.writing.tasks.email.averageScore, 4);
  assert.equal(range.writing.tasks.academic_discussion.attempts, 1);
  assert.equal(range.writing.tasks.academic_discussion.averageScore, null);

  // The wrongbook practice stays out of the BAS card but shows in the day
  // counters as one finished 今日错题 practice.
  const day1 = range.days.find((entry) => entry.date === "2026-10-01");
  assert.equal(day1.counts.build_sentence, 2);
  assert.equal(day1.counts.wrongbook_today, 1);
  assert.equal(day1.counts.email, 2);
});

test("sessions count once and their attempts never double count as Entry", () => {
  const range = buildTeacherStudentPracticeRange({
    reading: {
      attempts: [],
      wrongbookAttempts: [
        {
          attempt_id: "w-session-1",
          task_type: "ctw",
          status: "submitted",
          submitted_at: "2026-10-01T03:00:00.000Z"
        },
        {
          attempt_id: "w-session-2",
          task_type: "rdl",
          status: "submitted",
          submitted_at: "2026-10-01T04:00:00.000Z"
        },
        {
          attempt_id: "w-entry",
          task_type: "rap",
          status: "submitted",
          submitted_at: "2026-10-01T05:00:00.000Z"
        },
        {
          attempt_id: "w-active",
          task_type: "ctw",
          status: "submitted",
          submitted_at: "2026-10-02T03:00:00.000Z"
        }
      ],
      sessions: [
        {
          session_id: "s-history",
          task_type: "rdl",
          mode: "history",
          status: "completed",
          completed_at: "2026-10-01T04:00:00.000Z",
          progress: {
            "rdl-a": { attemptId: "w-session-1" },
            "rdl-b": { attemptId: "w-session-2" }
          }
        },
        {
          session_id: "s-active",
          task_type: "ctw",
          mode: "today",
          status: "active",
          completed_at: null,
          progress: { "ctw-a": { attemptId: "w-active" } }
        }
      ],
      fullSetAttempts: [],
      fullSetModules: []
    },
    timeZone: "Asia/Shanghai"
  });

  const day1 = range.days.find((entry) => entry.date === "2026-10-01");
  assert.equal(day1.counts.wrongbook_entry, 1);
  assert.equal(day1.counts.wrongbook_history, 1);
  assert.equal(day1.counts.wrongbook_today, 0);
  // An active session's attempt belongs to the session: it is neither an Entry
  // correction nor a finished-session count.
  const day2 = range.days.find((entry) => entry.date === "2026-10-02");
  assert.equal(day2, undefined);
});

test("sessions completed outside the range are not counted but still own attempts", () => {
  const range = buildTeacherStudentPracticeRange({
    startAt: "2026-10-01T00:00:00.000Z",
    endAt: "2026-10-02T00:00:00.000Z",
    reading: {
      attempts: [],
      wrongbookAttempts: [
        {
          attempt_id: "w-late-session",
          status: "submitted",
          submitted_at: "2026-10-01T05:00:00.000Z"
        }
      ],
      sessions: [
        {
          session_id: "s-late",
          mode: "history",
          status: "completed",
          completed_at: "2026-10-03T05:00:00.000Z",
          progress: { item: { attemptId: "w-late-session" } }
        }
      ],
      fullSetAttempts: [],
      fullSetModules: []
    },
    timeZone: "Asia/Shanghai"
  });

  // The attempt belongs to a session, so it is not an Entry correction; the
  // session completed after the range end, so no range day is counted.
  assert.deepEqual(range.days, []);
});

test("BAS wrong-question rows split into Entry and finished session practice", () => {
  const range = buildTeacherStudentPracticeRange({
    writing: {
      basAttempts: [
        {
          set_id: "wrongbook-today-20261001",
          set_title: "今日错题订正",
          correct_count: 1,
          total_questions: 5,
          submitted_at: "2026-10-01T02:00:00.000Z"
        },
        {
          set_id: "wrongbook-random-123",
          set_title: "历史错题练习",
          correct_count: 1,
          total_questions: 5,
          submitted_at: "2026-10-01T03:00:00.000Z"
        },
        {
          set_id: "wrongbook-today-20261001",
          set_title: "错题订正",
          correct_count: 1,
          total_questions: 1,
          submitted_at: "2026-10-01T04:00:00.000Z"
        },
        {
          set_id: "wrongbook-random-456",
          set_title: "历史错题订正",
          correct_count: 1,
          total_questions: 1,
          submitted_at: "2026-10-02T04:00:00.000Z"
        },
        {
          // Legacy row without a recognized title keeps the id classification.
          set_id: "wrongbook-today-20260930",
          set_title: null,
          correct_count: 0,
          total_questions: 1,
          submitted_at: "2026-09-30T04:00:00.000Z"
        }
      ],
      writingAttempts: []
    },
    timeZone: "Asia/Shanghai"
  });

  assert.equal(range.writing.tasks.build_sentence.attempts, 0);
  const day1 = range.days.find((entry) => entry.date === "2026-10-01");
  assert.equal(day1.counts.wrongbook_today, 1);
  assert.equal(day1.counts.wrongbook_history, 1);
  assert.equal(day1.counts.wrongbook_entry, 1);
  const day2 = range.days.find((entry) => entry.date === "2026-10-02");
  assert.equal(day2.counts.wrongbook_entry, 1);
  const legacy = range.days.find((entry) => entry.date === "2026-09-30");
  assert.equal(legacy.counts.wrongbook_today, 1);
});

test("only active dates appear, newest first, with all ten counters", () => {
  const range = buildTeacherStudentPracticeRange({
    reading: {
      attempts: [
        readingAttempt({ attempt_id: "r-1", submitted_at: "2026-10-03T02:00:00.000Z" }),
        readingAttempt({
          attempt_id: "r-2",
          logical_item_id: "rap-a",
          task_type: "rap",
          submitted_at: "2026-09-28T02:00:00.000Z"
        })
      ],
      wrongbookAttempts: [],
      sessions: [],
      fullSetAttempts: [],
      fullSetModules: []
    },
    timeZone: "Asia/Shanghai"
  });

  assert.deepEqual(range.days.map((day) => day.date), ["2026-10-03", "2026-09-28"]);
  for (const day of range.days) {
    assert.deepEqual(Object.keys(day.counts).sort(), Object.keys(emptyPracticeRangeDayCounts()).sort());
  }
  assert.equal(range.days[0].counts.ctw, 1);
  assert.equal(range.days[0].counts.rap, 0);
  assert.equal(range.days[1].counts.rap, 1);
});

test("day buckets follow the requested timezone", () => {
  assert.equal(
    practiceRangeDateKey("2026-10-01T16:30:00.000Z", "Asia/Shanghai"),
    "2026-10-02"
  );
  assert.equal(practiceRangeDateKey("2026-10-01T16:30:00.000Z", "UTC"), "2026-10-01");
  // Unknown zones fall back to the product calendar instead of throwing.
  assert.equal(
    practiceRangeDateKey("2026-10-01T16:30:00.000Z", "Not/AZone"),
    "2026-10-02"
  );
  assert.equal(practiceRangeDateKey("not-a-date", "Asia/Shanghai"), "");
});

test("BAS wrongbook classification keeps entry and session rows apart", () => {
  assert.equal(basAttemptCategory("wrongbook-today-20261001", "今日错题订正"), "today");
  assert.equal(basAttemptCategory("wrongbook-random-9", "历史错题练习"), "history");
  assert.equal(basAttemptCategory("wrongbook-today-20261001", "错题订正"), "entry");
  assert.equal(basAttemptCategory("wrongbook-random-9", "历史错题订正"), "entry");
  assert.equal(basAttemptCategory("wrongbook-today-20261001", null), "today");
  assert.equal(basAttemptCategory("wrongbook-all-9", null), "history");
  assert.equal(basAttemptCategory("set-1", "套题031"), "practice");
});

test("range API is binding-scoped, lightweight, and never reads content", () => {
  const route = read("app/api/teacher/students/[studentId]/practice-range/route.ts");
  assert.match(route, /requireTeacherOnly\(bearerToken\(request\)\)/);
  assert.match(route, /loadTeacherScope/);
  assert.match(route, /boundDomains\.includes\("reading"\)/);
  assert.match(route, /boundDomains\.includes\("writing"\)/);
  assert.match(route, /if \(!readingAllowed && !writingAllowed\)/);
  assert.match(route, /loadTeacherStudentPracticeRange\(/);
  assert.doesNotMatch(route, /listVisibleStudentIds|listTeacherStudentDomainBindings/);
  assert.doesNotMatch(route, /loadTeacherStudentReadingPractice|loadTeacherStudentWritingPractice/);

  const loader = read("lib/teacherStudentPracticeRange.server.ts");
  // Minimal scoring / counting columns only, always student- and range-scoped.
  assert.match(loader, /\.select\("task_type,status,correct_points,total_points,submitted_at"\)/);
  assert.match(loader, /\.select\("attempt_id,status,submitted_at"\)/);
  assert.match(loader, /\.select\("session_id,mode,status,completed_at,progress"\)/);
  assert.match(loader, /\.select\("attempt_id,completed_at"\)/);
  assert.match(loader, /\.select\("attempt_id,module_attempt_id,correct_points,total_points"\)/);
  assert.match(loader, /\.select\("set_id,set_title,correct_count,total_questions,submitted_at"\)/);
  assert.match(loader, /\.select\("attempt_id,task_type,submitted_at"\)/);
  assert.match(loader, /\.eq\("student_id", studentId\)/);
  assert.match(loader, /\.eq\("user_id", studentId\)/);
  assert.match(loader, /\.gte\("submitted_at", startAt\)/);
  assert.match(loader, /\.lt\("submitted_at", endAt\)/);
  assert.match(loader, /\.gte\("completed_at", startAt\)/);
  assert.match(loader, /\.lt\("completed_at", endAt\)/);
  assert.match(loader, /\.lt\("created_at", endAt\)/);
  assert.match(loader, /loadTeacherWritingReviewScores/);
  // No practice detail, answers, content, manifests or Full Set reviews.
  assert.doesNotMatch(
    loader,
    /student_answer|prompt|response_text|correct_order_text|manifest|reviewItems|logical_item_id/
  );
  assert.doesNotMatch(loader, /reading_full_set_answers/);
});

test("range view keeps the date area and adds no route change", () => {
  const component = read("components/teacher/TeacherStudentPracticeSection.tsx");
  // One picker control, same icon button size/style/position.
  assert.match(component, /<TeacherPopover/);
  assert.match(component, /sr-only">选择日期/);
  assert.match(component, /h-9 w-9 items-center justify-center rounded-lg border border-student-border bg-white/);
  assert.match(component, /aria-label="开始日期"/);
  assert.match(component, /aria-label="结束日期"/);
  assert.match(component, /查看当天/);
  assert.match(component, /查看范围统计/);
  assert.match(component, /上一天/);
  assert.match(component, /下一天/);
  assert.match(component, /今天/);
  assert.match(component, /practice-range\?\$\{params\.toString\(\)\}/);
  assert.match(component, /TEACHER_STUDENT_PRACTICE_RANGE_CACHE_PREFIX/);
  assert.match(component, /返回范围统计/);
  // No URL navigation for range selection.
  assert.doesNotMatch(component, /router\.(push|replace)|window\.location/);
});

test("range cards use one equal four-column grid for both rows", () => {
  const component = read("components/teacher/TeacherStudentPracticeSection.tsx");
  const rangeRegion = component.match(
    /function TeacherStudentPracticeRangeView[\s\S]*?function TeacherPracticeRangeDayList/
  )?.[0] ?? "";
  assert.notEqual(rangeRegion, "");
  assert.equal((rangeRegion.match(/sm:grid-cols-2 lg:grid-cols-4/g) ?? []).length, 2);
  // Writing row: BAS / WE / AD and no Full Set filler card.
  const writingRow = rangeRegion.match(/Writing 练习[\s\S]*?<\/section>/)?.[0] ?? "";
  assert.notEqual(writingRow, "");
  assert.match(writingRow, /data\.writing\.tasks\.build_sentence\.attempts/);
  assert.match(writingRow, /\(\["email", "academic_discussion"\] as const\)\.map/);
  assert.doesNotMatch(writingRow, /full_set/);

  // The ten-category date list is present and never renders practice records.
  const listRegion = component.match(
    /function TeacherPracticeRangeDayList[\s\S]*?function TeacherPracticeRangeReturnBar/
  )?.[0] ?? "";
  assert.notEqual(listRegion, "");
  assert.match(listRegion, /TEACHER_PRACTICE_RANGE_DAY_COUNT_KEYS\.map/);
  assert.match(listRegion, /TEACHER_PRACTICE_RANGE_DAY_COUNT_LABELS\[key\]/);
  assert.doesNotMatch(listRegion, /TeacherPracticeRecordList/);
});

test("range cache is invalidated with the single-day practice cache", () => {
  const cache = read("components/TeacherDataCache.tsx");
  assert.match(cache, /TEACHER_STUDENT_PRACTICE_RANGE_CACHE_PREFIX = "teacher:student-practice-range"/);
  const invalidationUsages = cache.match(
    /invalidate\(TEACHER_STUDENT_PRACTICE_RANGE_CACHE_PREFIX\)/g
  ) ?? [];
  assert.equal(invalidationUsages.length, 3);
});
