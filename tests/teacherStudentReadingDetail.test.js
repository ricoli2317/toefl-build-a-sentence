const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildTeacherStudentReadingPractice,
  buildTeacherStudentWritingPractice,
  teacherReadingAttemptHref
} = require("../lib/teacherStudentPractice.ts");

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

const ITEM_META = new Map([
  ["ctw-a", readingItem()],
  ["rdl-a", readingItem({ logical_item_id: "rdl-a", module: "rdl", displayName: "题目001" })]
]);

function readingAttempt(overrides) {
  return {
    attempt_id: "r-1",
    student_id: "student-9",
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

test("Reading practice, wrongbook, and Full Set records link by attempt id", () => {
  const practice = buildTeacherStudentReadingPractice({
    attempts: [readingAttempt({ attempt_id: "r-1" })],
    wrongbookAttempts: [
      {
        ...readingAttempt({
          attempt_id: "w-1",
          logical_item_id: "rdl-a",
          task_type: "rdl",
          correct_points: 1,
          total_points: 1
        }),
        scope: "today"
      }
    ],
    fullSetAttempts: [
      { attempt_id: "fs-1", full_set_id: "20260922", completed_at: "2026-09-22T05:00:00.000Z" }
    ],
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
    fullSetAnswers: [
      {
        module_attempt_id: "m1",
        occurrence_id: "m1-ctw-1",
        logical_item_id: "ctw-a",
        is_correct: true,
        answer_id: "a-1"
      }
    ],
    itemMeta: ITEM_META,
    studentId: "student-9"
  });

  assert.equal(
    practice.records.find((record) => record.attemptId === "r-1").href,
    "/teacher/students/student-9/reading/attempts/r-1"
  );
  assert.equal(
    practice.records.find((record) => record.attemptId === "w-1").href,
    "/teacher/students/student-9/reading/wrongbook-attempts/w-1"
  );
  const fullSetRecords = practice.records.filter((record) => record.kind === "full_set");
  assert.ok(fullSetRecords.length > 0);
  for (const record of fullSetRecords) {
    assert.equal(
      record.href,
      "/teacher/students/student-9/reading/full-set-attempts/fs-1"
    );
  }
});

test("Reading records never link without an exact attempt identity", () => {
  const practice = buildTeacherStudentReadingPractice({
    attempts: [readingAttempt({ attempt_id: "r-1" })],
    itemMeta: ITEM_META
  });
  // No student scope means no link rather than an invented one.
  assert.equal(practice.records[0].href, null);

  // Full-set correction attempts are not reachable from this list.
  const withFullSetCorrection = buildTeacherStudentReadingPractice({
    attempts: [],
    wrongbookAttempts: [
      {
        ...readingAttempt({ attempt_id: "w-fullset", task_type: "full_set" }),
        scope: "history"
      }
    ],
    itemMeta: ITEM_META,
    studentId: "student-9"
  });
  assert.equal(withFullSetCorrection.records[0].href, null);

  assert.equal(
    teacherReadingAttemptHref({ kind: "practice", attemptId: "r-1" }),
    null
  );
});

test("repeated attempts of one item produce distinct attempt routes", () => {
  const practice = buildTeacherStudentReadingPractice({
    attempts: [
      readingAttempt({ attempt_id: "attempt-old", submitted_at: "2026-09-20T01:00:00.000Z" }),
      readingAttempt({ attempt_id: "attempt-new", submitted_at: "2026-09-22T01:00:00.000Z" })
    ],
    itemMeta: ITEM_META,
    studentId: "student-9"
  });
  const hrefs = practice.records.map((record) => record.href).sort();
  assert.deepEqual(hrefs, [
    "/teacher/students/student-9/reading/attempts/attempt-new",
    "/teacher/students/student-9/reading/attempts/attempt-old"
  ]);
});

test("Reading summary records stay summary-only and Writing links are unchanged", () => {
  const practice = buildTeacherStudentReadingPractice({
    attempts: [readingAttempt({ attempt_id: "r-1" })],
    itemMeta: ITEM_META,
    studentId: "student-9"
  });
  const record = practice.records[0];
  for (const forbidden of ["practice", "answers", "disclosures", "reviewItems", "targets"]) {
    assert.equal(forbidden in record, false);
  }

  const writing = buildTeacherStudentWritingPractice({
    basAttempts: [
      {
        attempt_id: "b-1",
        set_id: "set-1",
        set_title: "旧题名",
        correct_count: 8,
        total_questions: 10,
        time_spent_seconds: 120,
        submitted_at: "2026-09-22T02:00:00.000Z"
      }
    ],
    basTitles: new Map([["set-1", "套题031"]]),
    studentId: "student-9",
    writingAttempts: [],
    writingDisplayNames: new Map()
  });
  assert.equal(
    writing.records[0].href,
    "/teacher/students/student-9/details/set-1"
  );
});

test("student detail list adds no Reading detail fetch", () => {
  const list = read("components/teacher/TeacherStudentPracticeSection.tsx");
  assert.doesNotMatch(list, /reading\/attempts|reading\/wrongbook-attempts|reading\/full-set-attempts/);
  assert.doesNotMatch(list, /ReadingReadonlyReviewShell|ReadingFullSetReviewShell/);
  assert.equal((list.match(/fetch\(/g) ?? []).length, 1);
});

test("teacher Reading detail pages route by attempt id and reuse the read-only shells", () => {
  const pages = [
    ["app/teacher/students/[studentId]/reading/attempts/[attemptId]/page.tsx", "\"attempt\""],
    ["app/teacher/students/[studentId]/reading/wrongbook-attempts/[attemptId]/page.tsx", "\"wrongbook\""],
    ["app/teacher/students/[studentId]/reading/full-set-attempts/[attemptId]/page.tsx", "\"full-set\""]
  ];
  for (const [file, kind] of pages) {
    const source = read(file);
    assert.match(source, new RegExp(`kind=${kind.replace(/"/g, '"')}`));
    assert.match(source, /attemptId=\{params\.attemptId\}/);
    assert.match(source, /studentId=\{params\.studentId\}/);
    assert.match(source, /TeacherStudentReadingAttemptDetail/);
  }

  const ui = read("components/teacher/TeacherStudentReadingAttemptDetail.tsx");
  assert.match(ui, /TEACHER_STUDENT_READING_CACHE_PREFIX/);
  assert.match(ui, /useTeacherCachedData/);
  assert.match(ui, /ReadingReadonlyReviewShell/);
  assert.match(ui, /ReadingFullSetReviewShell/);
  assert.match(ui, /reading\/full-set-attempts\/\$\{encodeURIComponent\(attemptId\)\}/);
  assert.match(ui, /kind === "wrongbook" \? "wrongbook-attempts" : "attempts"/);
  // Teacher detail must never call the student review APIs.
  assert.doesNotMatch(ui, /\/api\/reading\//);
});

test("teacher Reading detail APIs are binding-scoped and load one attempt by id", () => {
  const routes = [
    "app/api/teacher/students/[studentId]/reading/attempts/[attemptId]/route.ts",
    "app/api/teacher/students/[studentId]/reading/wrongbook-attempts/[attemptId]/route.ts",
    "app/api/teacher/students/[studentId]/reading/full-set-attempts/[attemptId]/route.ts"
  ];
  for (const file of routes) {
    const route = read(file);
    assert.match(route, /requireTeacherOnly\(bearerToken\(request\)\)/);
    assert.match(route, /loadTeacherScope/);
    assert.match(route, /scope\.studentDomains\.get\(studentId\)\?\.includes\("reading"\)/);
    assert.match(route, /\.eq\("attempt_id", attemptId\)|db, studentId, attemptId/);
    assert.match(route, /insertSupabaseDebugMetrics|debugMetrics/);
  }

  const lib = read("lib/teacherStudentReadingAttempt.server.ts");
  assert.match(lib, /\.eq\("attempt_id", attemptId\)/);
  assert.match(lib, /\.eq\("student_id", studentId\)/);
  assert.match(lib, /loadStudentReadingPractice/);
  assert.match(lib, /buildSubmittedReadingAnswerState/);
  assert.match(lib, /buildSubmittedReadingReviewItems/);
  assert.match(lib, /loadReadingAnswerDisclosures/);
  assert.match(lib, /loadReadingFullSetFinalSnapshot/);
  assert.doesNotMatch(lib, /listVisibleStudentIds|listTeacherStudentDomainBindings/);
});

test("Full Set teacher review drops student-only question hrefs", () => {
  const lib = read("lib/teacherStudentReadingAttempt.server.ts");
  assert.match(
    lib,
    /reviewItems: snapshot\.review\.reviewItems\.map\(\(\{ href: _href, \.\.\.item \}\) => item\)/
  );
  const practice = read("components/reading/ReadingPractice.tsx");
  assert.match(practice, /export function ReadingFullSetReviewShell/);
});
