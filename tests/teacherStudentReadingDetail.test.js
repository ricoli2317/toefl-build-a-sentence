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
    displayName: "题目001",
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
    "/teacher/students/student-9/attempts/b-1"
  );
});

test("student detail list adds no Reading detail fetch", () => {
  const list = read("components/teacher/TeacherStudentPracticeSection.tsx");
  assert.doesNotMatch(list, /reading\/attempts|reading\/wrongbook-attempts|reading\/full-set-attempts/);
  assert.doesNotMatch(list, /ReadingReadonlyReviewShell|ReadingFullSetReviewShell/);
  // Two scoped, summary-only fetches: the single-day practice payload and the
  // lightweight range statistics. Neither loads attempt detail.
  assert.equal((list.match(/fetch\(/g) ?? []).length, 2);
  assert.match(list, /\/practice\?\$\{params\.toString\(\)\}/);
  assert.match(list, /\/practice-range\?\$\{params\.toString\(\)\}/);
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
    assert.match(source, /questionIndex=\{teacherReadingQuestionIndex\(searchParams\?\.question\)\}/);
    assert.match(source, /TeacherStudentReadingAttemptDetail/);
  }

  const ui = read("components/teacher/TeacherStudentReadingAttemptDetail.tsx");
  assert.match(ui, /TEACHER_STUDENT_READING_CACHE_PREFIX/);
  assert.match(ui, /useTeacherCachedData/);
  // Every record opens the student-shaped RESULT view first (summary + question
  // chips) and only a chip opens the read-only question shell.
  assert.match(ui, /PracticeResultSummary/);
  assert.match(ui, /ReadingQuestionStatusChips/);
  assert.match(ui, /data-testid="teacher-reading-result"/);
  assert.match(ui, /\?question=\$\{index\}/);
  assert.match(ui, /questionIndex !== undefined/);
  assert.match(ui, /ReadingReadonlyReviewShell/);
  assert.match(ui, /initialReviewIndex=\{questionIndex\}/);
  assert.match(ui, /ReadingFullSetReviewShell/);
  assert.match(ui, /initialSourceAnswerIndex=\{questionIndex\}/);
  assert.match(ui, /reading\/full-set-attempts\/\$\{encodeURIComponent\(attemptId\)\}/);
  assert.match(ui, /kind === "wrongbook"[\s\S]*"wrongbook-attempts"[\s\S]*"full-set-attempts"[\s\S]*"attempts"/);
  // A session-backed record renders the whole session result and review through
  // the same multi-source shell (with the session status bar) the student sees.
  assert.match(ui, /"sessionDetail" in payload/);
  assert.match(ui, /payload\.sessionDetail\.review/);
  assert.match(ui, /view\.mode === "session" \? "session" : "full_set"/);
  // An unfinished session never degrades into the single-material read-only page.
  assert.match(ui, /"sessionIncomplete" in state\.data/);
  assert.match(ui, /description="这次练习还没有完成。"/);
  // Full Set uses the student's module-grouped question navigator.
  assert.match(ui, /ReadingFullSetQuestionNavigator/);
  assert.match(ui, /<ReadingFullSetQuestionNavigator items=\{fullSetItems\} \/>/);
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

  const wrongbookRoute = read(
    "app/api/teacher/students/[studentId]/reading/wrongbook-attempts/[attemptId]/route.ts"
  );
  // Session-backed attempts open the whole session result + review; an
  // unfinished session reports itself as such and never falls back to the
  // single-material view; only non-session attempts (entry / Full Set
  // corrections) use the single-attempt view.
  assert.match(wrongbookRoute, /loadTeacherStudentReadingWrongbookSessionDetail\(db, studentId, attemptId\)/);
  assert.match(wrongbookRoute, /if \(sessionLookup\.kind === "incomplete"\) \{/);
  assert.match(wrongbookRoute, /sessionIncomplete: true/);
  assert.match(wrongbookRoute, /if \(sessionLookup\.kind === "session"\) \{/);
  assert.match(wrongbookRoute, /sessionDetail: \{/);
  assert.match(wrongbookRoute, /loadTeacherStudentReadingWrongbookAttemptReview\(db, studentId, attemptId\)/);

  const lib = read("lib/teacherStudentReadingAttempt.server.ts");
  assert.match(lib, /\.eq\("attempt_id", attemptId\)/);
  assert.match(lib, /\.eq\("student_id", studentId\)/);
  assert.match(lib, /loadStudentReadingPractice/);
  assert.match(lib, /buildSubmittedReadingAnswerState/);
  assert.match(lib, /buildSubmittedReadingReviewItems\(practice, correctionRows\)/);
  assert.match(lib, /loadReadingAnswerDisclosures/);
  assert.match(lib, /loadReadingFullSetFinalSnapshot/);
  // Result-view numbers come from the attempt rows the student result also uses.
  assert.match(lib, /correctPoints: nonNegativeInteger\(attempt\.correct_points\)/);
  assert.match(lib, /totalPoints: nonNegativeInteger\(attempt\.total_points\)/);
  assert.match(lib, /elapsedSeconds: nonNegativeInteger\(attempt\.elapsed_seconds\)/);
  // The session drill-down resolves the attempt back to its frozen session and
  // reuses the student session payload builder plus its summed result numbers.
  assert.match(lib, /loadTeacherStudentReadingWrongbookSessionDetail/);
  assert.match(lib, /student_wrong_question_sessions/);
  assert.match(lib, /buildReadingWrongbookSessionReviewPayload\(/);
  assert.match(lib, /reviewItems: payload\.reviewItems\.map\(\(\{ href: _href, \.\.\.item \}\) => item\)/);
  assert.match(lib, /scoreDisplay: snapshot\.result\.score\.display/);
  // Three-way lookup: not-a-session, unfinished (no result, never a
  // single-material view) and the finished session itself.
  assert.match(lib, /\| \{ kind: "none" \}/);
  assert.match(lib, /\| \{ kind: "incomplete" \}/);
  assert.match(lib, /groups\.some\(\(group\) => !session\.progress\?\.\[group\.logicalItemId\]\?\.attemptId\)/);
  assert.match(lib, /TEACHER_READING_SESSION_MANIFEST_MISSING/);
  assert.match(lib, /TEACHER_READING_SESSION_SOURCE_MISSING/);
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

test("teacher single-attempt review matches the student correction view", () => {
  const lib = read("lib/teacherStudentReadingAttempt.server.ts");
  // Navigation items are the target rows only, exactly like the student review.
  assert.match(lib, /const correctionRows = \(answerResult\.data \?\? \[\]\) as SubmittedReadingAnswerRow\[\]/);
  assert.match(lib, /reviewItems: buildSubmittedReadingReviewItems\(practice, correctionRows\)/);
  // The paragraph keeps the student's read-only context and tolerates CTW slots
  // outside the attempt, matching the practice and the student review.
  assert.match(lib, /tolerateMissingCtwSlots: true/);
  assert.match(
    lib,
    /options\?\.includeContext\s*\n\s*&& attempt\.task_type === "ctw"\s*\n\s*&& attempt\.scope === "history"/
  );
});

test("one Full Set is one record and the list names it like the student result", () => {
  const loader = read("lib/teacherStudentPractice.server.ts");
  assert.match(loader, /fullSetTitles/);
  assert.match(loader, /loadReadingFullSet\(db, fullSetId\)/);
  const lib = read("lib/teacherStudentPractice.ts");
  // Aggregated record: whole attempt, one score, no per-module split.
  assert.match(lib, /recordId: `full_set:\$\{attempt\.attempt_id\}`/);
  assert.match(lib, /taskType: "full_set"/);
  assert.match(lib, /fullSetTitles\?\.get\(String\(attempt\.full_set_id\)\)/);
  assert.doesNotMatch(lib, /recordId: `full_set:\$\{attempt\.attempt_id\}:\$\{taskType\}`/);
  // The FS checkbox label exists alongside the other task types.
  assert.match(lib, /full_set: "FS"/);
});

test("BAS records open the attempt result, then the read-only question page", () => {
  const lib = read("lib/teacherStudentPractice.ts");
  // The record never lands on the set-wide attempt list any more.
  assert.match(lib, /attempts\/\$\{encodeURIComponent\(String\(attempt\.attempt_id\)\)\}/);
  assert.doesNotMatch(lib, /href: `\/teacher\/students\/\$\{encodeURIComponent\(input\.studentId\)\}\/details\//);

  const page = read("app/teacher/students/[studentId]/attempts/[attemptId]/page.tsx");
  assert.match(page, /TeacherStudentAttemptResult/);
  assert.match(page, /attemptId=\{params\.attemptId\}/);
  assert.match(page, /studentId=\{params\.studentId\}/);

  const api = read("app/api/teacher/students/[studentId]/attempts/[attemptId]/route.ts");
  assert.match(api, /requireTeacherOnly\(bearerToken\(request\)\)/);
  assert.match(api, /loadTeacherScope/);
  assert.match(api, /scope\.studentDomains\.get\(studentId\)\?\.includes\("writing"\)/);
  assert.match(api, /loadTeacherStudentBasAttemptResult\(db, studentId, attemptId\)/);

  const server = read("lib/teacherStudentPractice.server.ts");
  assert.match(server, /export async function loadTeacherStudentBasAttemptResult/);
  assert.match(server, /loadTeacherStudentBasAttemptDetail\(db, studentId, attemptId, ""\)/);
  // The per-question page keeps working through the same core loader.
  assert.match(
    server,
    /return loadTeacherStudentBasAttemptDetail\(\s*\n\s*db,\s*\n\s*studentId,\s*\n\s*String\(initialAnswer\.attempt_id\),\s*\n\s*String\(initialAnswer\.question_id\)\s*\n\s*\);/
  );

  const dashboard = read("components/TeacherDashboard.tsx");
  // Result view = the student's own result component, question chips included.
  assert.match(dashboard, /export function TeacherStudentAttemptResult/);
  assert.match(dashboard, /selectInitialQuestion=\{false\}/);
  assert.match(dashboard, /studentId\}:attempt:\$\{attemptId\}/);
  assert.match(dashboard, /initialQuestionId=\{initialAnswer\?\.questionId\}/);
});

test("entry corrections are titled 错题订正·材料名", () => {
  const practice = buildTeacherStudentReadingPractice({
    attempts: [],
    wrongbookAttempts: [
      {
        ...readingAttempt({
          attempt_id: "entry-1",
          logical_item_id: "ctw-a",
          task_type: "ctw",
          correct_points: 1,
          total_points: 2
        }),
        scope: "today"
      }
    ],
    itemMeta: ITEM_META,
    studentId: "student-9"
  });
  const entry = practice.records[0];
  assert.equal(entry.kind, "wrongbook");
  assert.equal(entry.title, "错题订正·题目001");
  // Material identity is not lost when the meta is unknown: the task name still
  // follows the unified prefix.
  const unknown = buildTeacherStudentReadingPractice({
    attempts: [],
    wrongbookAttempts: [
      {
        ...readingAttempt({
          attempt_id: "entry-2",
          logical_item_id: "ctw-unknown",
          task_type: "ctw"
        }),
        scope: "history"
      }
    ],
    itemMeta: ITEM_META,
    studentId: "student-9"
  });
  assert.equal(unknown.records[0].title, "错题订正·Complete the Words");
});
