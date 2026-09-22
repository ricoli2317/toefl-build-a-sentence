const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  aggregateTeacherStudentPracticeSummaries,
  buildTeacherStudentOverview,
  buildTeacherStudentOverviewFromSummaries,
  formatLatestPracticeAt,
  formatPracticeDuration
} = require("../lib/teacherStudentOverview.ts");
const {
  listTeacherStudentDomainBindings,
  listVisibleStudentIds
} = require("../lib/accountAccess.ts");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const STUDENT = "student-s";
const TEACHER_A = "teacher-a";
const TEACHER_B = "teacher-b";

function practiceRows() {
  return [
    { studentId: STUDENT, source: "reading", durationSeconds: 100, completedAt: "2026-09-22T09:00:00Z" },
    { studentId: STUDENT, source: "build-sentence", durationSeconds: 200, completedAt: "2026-09-22T10:00:00Z" },
    { studentId: STUDENT, source: "writing", durationSeconds: 300, completedAt: "2026-09-22T11:00:00Z" }
  ];
}

function bindingTables() {
  return {
    profiles: [
      { id: TEACHER_A, role: "teacher", is_active: true },
      { id: TEACHER_B, role: "teacher", is_active: true },
      { id: STUDENT, role: "student", is_active: true }
    ],
    teacher_student_bindings: [
      { binding_id: "b-a", teacher_id: TEACHER_A, student_id: STUDENT, domain: "reading" },
      { binding_id: "b-b", teacher_id: TEACHER_B, student_id: STUDENT, domain: "writing" }
    ]
  };
}

test("Case 4/5/6: both domain teachers see the same student with identical summaries", () => {
  const readingTeacher = buildTeacherStudentOverview({
    students: [{
      studentId: STUDENT,
      studentDisplayName: "Student S",
      studentEmail: "s@example.com",
      domains: ["reading"]
    }],
    practiceRows: practiceRows()
  });
  const writingTeacher = buildTeacherStudentOverview({
    students: [{
      studentId: STUDENT,
      studentDisplayName: "Student S",
      studentEmail: "s@example.com",
      domains: ["writing"]
    }],
    practiceRows: practiceRows()
  });

  assert.equal(readingTeacher[0].totalPracticeSeconds, 600);
  assert.equal(writingTeacher[0].totalPracticeSeconds, 600);
  assert.equal(readingTeacher[0].latestPracticeAt, "2026-09-22T11:00:00Z");
  assert.equal(writingTeacher[0].latestPracticeAt, "2026-09-22T11:00:00Z");
  assert.deepEqual(readingTeacher[0].domains, ["reading"]);
  assert.deepEqual(writingTeacher[0].domains, ["writing"]);
});

test("Case 7: the shared summary never carries assignment or attempt details", () => {
  const [entry] = buildTeacherStudentOverview({
    students: [{
      studentId: STUDENT,
      studentDisplayName: "Student S",
      studentEmail: "s@example.com",
      domains: ["reading", "writing"]
    }],
    practiceRows: practiceRows()
  });
  assert.deepEqual(Object.keys(entry).sort(), [
    "domains",
    "latestPracticeAt",
    "studentDisplayName",
    "studentEmail",
    "studentId",
    "totalPracticeSeconds"
  ]);
  assert.deepEqual(entry.domains, ["reading", "writing"]);
});

test("Case 8: domains are always returned in canonical reading/writing order", () => {
  const [entry] = buildTeacherStudentOverview({
    students: [{
      studentId: STUDENT,
      studentDisplayName: "Student S",
      studentEmail: "s@example.com",
      domains: ["writing", "reading"]
    }],
    practiceRows: []
  });
  assert.deepEqual(entry.domains, ["reading", "writing"]);
  assert.equal(entry.totalPracticeSeconds, 0);
  assert.equal(entry.latestPracticeAt, null);
});

test("aggregation only counts stored durations and canonical completed timestamps", () => {
  const summaries = aggregateTeacherStudentPracticeSummaries([
    { studentId: "s-1", source: "reading", durationSeconds: null, completedAt: "2026-09-22T09:00:00Z" },
    { studentId: "s-1", source: "reading", durationSeconds: Number.NaN, completedAt: "not-a-date" },
    { studentId: "s-1", source: "build-sentence", durationSeconds: -50, completedAt: null },
    { studentId: "s-1", source: "writing", durationSeconds: 12.6, completedAt: "2026-09-21T09:00:00Z" },
    { studentId: "s-1", source: "reading-full-set", durationSeconds: null, completedAt: "2026-09-22T11:00:00Z" }
  ]);
  assert.equal(summaries.get("s-1").totalPracticeSeconds, 13);
  assert.equal(summaries.get("s-1").latestPracticeAt, "2026-09-22T11:00:00Z");
  assert.equal(summaries.size, 1);
});

test("aggregation is stable across many records and ignores empty student ids", () => {
  const rows = Array.from({ length: 1_000 }, (_, index) => ({
    studentId: index % 3 === 0 ? "s-1" : index % 3 === 1 ? "s-2" : "",
    source: "reading",
    durationSeconds: 60,
    completedAt: `2026-09-22T${String(index % 24).padStart(2, "0")}:00:00Z`
  }));
  const summaries = aggregateTeacherStudentPracticeSummaries(rows);
  assert.equal(summaries.get("s-1").totalPracticeSeconds, 334 * 60);
  assert.equal(summaries.get("s-2").totalPracticeSeconds, 333 * 60);
  assert.equal(summaries.size, 2);
});

test("Case 1/2/3: visibility and domains stay binding-scoped for every teacher", async () => {
  const db = createMockSupabase(bindingTables());
  const teacherA = { userId: TEACHER_A, role: "teacher" };
  const teacherB = { userId: TEACHER_B, role: "teacher" };
  const teacherNone = { userId: "teacher-none", role: "teacher" };

  assert.deepEqual(await listVisibleStudentIds(db, teacherA), [STUDENT]);
  assert.deepEqual(await listVisibleStudentIds(db, teacherB), [STUDENT]);
  assert.deepEqual(await listVisibleStudentIds(db, teacherNone), []);

  const bindingsA = await listTeacherStudentDomainBindings(db, teacherA);
  const bindingsB = await listTeacherStudentDomainBindings(db, teacherB);
  assert.deepEqual(bindingsA.studentDomains.get(STUDENT), ["reading"]);
  assert.deepEqual(bindingsB.studentDomains.get(STUDENT), ["writing"]);

  const overviewA = buildTeacherStudentOverview({
    students: [{ studentId: STUDENT, studentDisplayName: "S", studentEmail: "", domains: bindingsA.studentDomains.get(STUDENT) }],
    practiceRows: practiceRows()
  });
  const overviewB = buildTeacherStudentOverview({
    students: [{ studentId: STUDENT, studentDisplayName: "S", studentEmail: "", domains: bindingsB.studentDomains.get(STUDENT) }],
    practiceRows: practiceRows()
  });
  assert.equal(overviewA[0].totalPracticeSeconds, overviewB[0].totalPracticeSeconds);
  assert.equal(overviewA[0].latestPracticeAt, overviewB[0].latestPracticeAt);
  assert.deepEqual(overviewA[0].domains, ["reading"]);
  assert.deepEqual(overviewB[0].domains, ["writing"]);
});

test("practice duration and latest practice formatters match the product copy", () => {
  assert.equal(formatPracticeDuration(null), "—");
  assert.equal(formatPracticeDuration(undefined), "—");
  assert.equal(formatPracticeDuration(0), "—");
  assert.equal(formatPracticeDuration(45), "<1分钟");
  assert.equal(formatPracticeDuration(60), "1分钟");
  assert.equal(formatPracticeDuration(48 * 60), "48分钟");
  assert.equal(formatPracticeDuration(2 * 3600), "2小时");
  assert.equal(formatPracticeDuration(2 * 3600 + 18 * 60), "2小时18分钟");

  const localMoment = new Date();
  localMoment.setMonth(8, 22);
  localMoment.setHours(10, 35, 0, 0);
  assert.equal(formatLatestPracticeAt(localMoment.toISOString()), "9月22日 10:35");
  assert.equal(formatLatestPracticeAt(null), "—");
  assert.equal(formatLatestPracticeAt("not-a-date"), "—");
});

test("overview API is teacher-only, batch-scoped, and never reads practice history", () => {
  const route = read("app/api/teacher/students/overview/route.ts");
  const scopeLib = read("lib/teacherScope.server.ts");
  assert.match(route, /requireTeacherOnly\(bearerToken\(request\)\)/);
  assert.match(route, /status: 403/);
  assert.match(route, /loadTeacherScope/);
  assert.match(scopeLib, /from\("teacher_student_bindings"\)/);
  assert.doesNotMatch(scopeLib, /owner_id/);
  assert.match(route, /readAllSupabaseRows/);
  assert.match(route, /Cache-Control[\s\S]{0,30}"no-store"/);
  assert.match(route, /from\("student_practice_summary"\)/);
  assert.match(route, /select\("student_id,total_practice_seconds,latest_practice_at"\)/);
  assert.match(route, /\.in\("student_id", batch\)/);
  assert.match(route, /buildTeacherStudentOverviewFromSummaries/);
  assert.doesNotMatch(route, /from\("reading_attempts"\)/);
  assert.doesNotMatch(route, /from\("reading_wrongbook_attempts"\)/);
  assert.doesNotMatch(route, /from\("attempts"\)/);
  assert.doesNotMatch(route, /from\("writing_attempts"\)/);
  assert.doesNotMatch(route, /from\("reading_full_set_attempts"\)/);
  assert.doesNotMatch(route, /TeacherStudentPracticeRow|practiceRow\(/);
  assert.doesNotMatch(
    route,
    /reading_attempt_answers|reading_full_set_answers|reading_wrongbook_attempt_answers|from\("attempt_answers"\)|writing_reviews|response_text|question_snapshot|official_score/
  );
  // No N students -> N requests: no query is issued inside a per-student loop.
  assert.doesNotMatch(route, /for\s*\([^)]*studentId[^)]*\)[\s\S]{0,300}\.from\(/);
});

test("summary overview maps rows, defaults missing students, and keeps students isolated", () => {
  const students = [
    { studentId: "student-a", studentDisplayName: "甲", studentEmail: "a@example.com", domains: ["writing", "reading"] },
    { studentId: "student-b", studentDisplayName: "乙", studentEmail: "b@example.com", domains: ["reading"] },
    { studentId: "student-c", studentDisplayName: "丙", studentEmail: "c@example.com", domains: [] }
  ];
  const overview = buildTeacherStudentOverviewFromSummaries({
    students,
    summaries: [
      { studentId: "student-a", totalPracticeSeconds: 610, latestPracticeAt: "2026-09-22T10:00:00Z" },
      { studentId: "student-b", totalPracticeSeconds: 0, latestPracticeAt: "2026-09-21T08:30:00Z" }
    ]
  });

  assert.deepEqual(overview.map((entry) => entry.studentId), ["student-a", "student-b", "student-c"]);
  assert.equal(overview[0].totalPracticeSeconds, 610);
  assert.equal(overview[0].latestPracticeAt, "2026-09-22T10:00:00Z");
  assert.deepEqual(overview[0].domains, ["reading", "writing"]);
  assert.equal(overview[1].totalPracticeSeconds, 0);
  assert.equal(overview[1].latestPracticeAt, "2026-09-21T08:30:00Z");
  assert.equal(overview[2].totalPracticeSeconds, 0);
  assert.equal(overview[2].latestPracticeAt, null);
});

test("summary overview tolerates NULL, negative, fractional, and unknown rows", () => {
  const overview = buildTeacherStudentOverviewFromSummaries({
    students: [
      { studentId: "student-a", studentDisplayName: "甲", studentEmail: "", domains: ["reading"] },
      { studentId: "student-b", studentDisplayName: "乙", studentEmail: "", domains: ["writing"] },
      { studentId: "student-c", studentDisplayName: "丙", studentEmail: "", domains: ["reading"] }
    ],
    summaries: [
      { studentId: "student-a", totalPracticeSeconds: null, latestPracticeAt: null },
      { studentId: "student-b", totalPracticeSeconds: -50, latestPracticeAt: "not-a-date" },
      { studentId: "  ", totalPracticeSeconds: 999, latestPracticeAt: "2026-09-22T10:00:00Z" },
      { studentId: "student-c", totalPracticeSeconds: 12.6, latestPracticeAt: "2026-09-22T10:00:00Z" }
    ]
  });

  assert.equal(overview[0].totalPracticeSeconds, 0);
  assert.equal(overview[0].latestPracticeAt, null);
  assert.equal(overview[1].totalPracticeSeconds, 0);
  assert.equal(overview[1].latestPracticeAt, null);
  assert.equal(overview[2].totalPracticeSeconds, 13);
  assert.equal(overview[2].latestPracticeAt, "2026-09-22T10:00:00Z");
});

test("Case 3: an empty roster returns an empty students array without any query", () => {
  const route = read("app/api/teacher/students/overview/route.ts");
  assert.match(route, /if \(scope\.visibleStudentIds\.length === 0\) \{\s*return json\(\{ students: \[\] \}\);\s*\}/);

  const list = read("components/teacher/TeacherStudentOverview.tsx");
  assert.match(list, /StudentOverviewResponse/);
  assert.match(list, /暂无学生。/);
});

test("student list UI only renders the lightweight overview surface", () => {
  const list = read("components/teacher/TeacherStudentOverview.tsx");
  assert.match(list, /TEACHER_STUDENT_OVERVIEW_CACHE_KEY/);
  assert.match(list, /\/api\/teacher\/students\/overview/);
  assert.match(list, /练习总时间/);
  assert.match(list, /最近练习/);
  assert.match(list, /学科/);
  assert.match(list, /reading: "阅读"/);
  assert.match(list, /writing: "写作"/);
  assert.match(list, /支持中文精确搜索，例如：张三；支持拼音模糊搜索，例如：zhang \/ san/);
  assert.match(list, /\/teacher\/writing\/assignments\?studentId=\$\{encodeURIComponent\(entry\.student\.studentId\)\}/);
  assert.match(list, /\/teacher\/students\/\$\{encodeURIComponent\(entry\.student\.studentId\)\}/);
  assert.match(list, /查看详情\n\s*<\/Link>/);
  assert.doesNotMatch(list, /写作平均正确率|写作完成套题数|写作练习次数|CTW 平均正确率|RDL 平均正确率|RAP 平均正确率|邮件平均分|学术讨论平均分/);
  assert.doesNotMatch(list, /DomainChip/);
  assert.doesNotMatch(list, /useTeacherStats|TEACHER_STATS_CACHE_KEY/);
});
