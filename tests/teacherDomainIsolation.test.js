const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { listTeacherStudentDomainBindings } = require("../lib/accountAccess.ts");
const {
  buildTeacherStudentReadingDetail
} = require("../lib/reading/teacherStats.ts");
const { buildTeacherDashboardActivity } = require("../lib/teacherDashboard.ts");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

function tables() {
  return {
    profiles: [
      { id: "teacher-1", role: "teacher", is_active: true },
      { id: "teacher-2", role: "teacher", is_active: true },
      { id: "teacher-owner", role: "teacher", is_active: true },
      { id: "admin-1", role: "admin", is_active: true },
      { id: "student-1", role: "student", is_active: true, owner_id: "teacher-owner" },
      { id: "student-2", role: "student", is_active: true, owner_id: "teacher-owner" }
    ],
    teacher_student_bindings: [
      { binding_id: "b1", teacher_id: "teacher-1", student_id: "student-1", domain: "reading" },
      { binding_id: "b2", teacher_id: "teacher-1", student_id: "student-2", domain: "writing" },
      { binding_id: "b3", teacher_id: "teacher-1", student_id: "student-2", domain: "reading" },
      { binding_id: "b4", teacher_id: "teacher-2", student_id: "student-1", domain: "writing" }
    ]
  };
}

test("Case 1/2/3/4: teacher domains and per-student domains come from bindings only", async () => {
  const db = createMockSupabase(tables());
  const teacher1 = await listTeacherStudentDomainBindings(db, {
    userId: "teacher-1",
    role: "teacher"
  });
  assert.deepEqual(teacher1.teacherDomains, ["reading", "writing"]);
  assert.deepEqual(teacher1.studentDomains.get("student-1"), ["reading"]);
  assert.deepEqual(teacher1.studentDomains.get("student-2"), ["reading", "writing"]);

  const teacher2 = await listTeacherStudentDomainBindings(db, {
    userId: "teacher-2",
    role: "teacher"
  });
  assert.deepEqual(teacher2.teacherDomains, ["writing"]);
  assert.deepEqual(teacher2.studentDomains.get("student-1"), ["writing"]);
});

test("Case 5: profiles.owner_id never grants a teaching domain", async () => {
  const db = createMockSupabase(tables());
  const owner = await listTeacherStudentDomainBindings(db, {
    userId: "teacher-owner",
    role: "teacher"
  });
  assert.deepEqual(owner.teacherDomains, []);
  assert.equal(owner.studentDomains.size, 0);
});

test("Case 7: Admin has no teacher binding domains", async () => {
  const db = createMockSupabase(tables());
  const admin = await listTeacherStudentDomainBindings(db, {
    userId: "admin-1",
    role: "admin"
  });
  assert.deepEqual(admin.teacherDomains, []);
  assert.equal(admin.studentDomains.size, 0);
});

function readingItem(overrides) {
  return {
    logical_item_id: "ctw-a",
    module: "ctw",
    title: null,
    first_seen_date: "2026-05-01",
    first_seen_source_label: "May",
    first_seen_source_order: 1,
    question_count: 1,
    scored_item_count: 2,
    ...overrides
  };
}

function readingAttempt(overrides) {
  return {
    attempt_id: "attempt-1",
    student_id: "student-a",
    logical_item_id: "ctw-a",
    task_type: "ctw",
    status: "submitted",
    elapsed_seconds: 60,
    total_points: 2,
    correct_points: 1,
    submitted_at: "2026-06-01T01:00:00Z",
    ...overrides
  };
}

test("Case 1: Reading student detail reuses teacher Reading stats and marks wrongbook entries", () => {
  const profile = { id: "student-a", email: "a@example.com", full_name: "Alpha" };
  const items = [
    readingItem({ logical_item_id: "ctw-a", first_seen_date: "2026-05-01" }),
    readingItem({ logical_item_id: "ctw-b", first_seen_date: "2026-05-02" }),
    readingItem({
      logical_item_id: "rdl-a",
      module: "rdl",
      title: "Library Notice",
      first_seen_date: "2026-05-03"
    })
  ];
  const detail = buildTeacherStudentReadingDetail({
    profile,
    items,
    attempts: [
      readingAttempt({
        attempt_id: "a-ctw-b",
        logical_item_id: "ctw-b",
        correct_points: 1,
        total_points: 2,
        submitted_at: "2026-06-01T01:00:00Z"
      }),
      readingAttempt({
        attempt_id: "a-ctw-a",
        logical_item_id: "ctw-a",
        correct_points: 2,
        total_points: 2,
        elapsed_seconds: 120,
        submitted_at: "2026-06-02T01:00:00Z"
      }),
      readingAttempt({
        attempt_id: "draft",
        logical_item_id: "ctw-a",
        status: "draft",
        submitted_at: null
      })
    ],
    wrongbookAttempts: [
      {
        attempt_id: "w-rdl",
        student_id: "student-a",
        logical_item_id: "rdl-a",
        task_type: "rdl",
        scope: "today",
        status: "submitted",
        elapsed_seconds: 30,
        total_points: 1,
        correct_points: 1,
        submitted_at: "2026-06-03T01:00:00Z"
      }
    ]
  });

  assert.equal(detail.student.displayName, "Alpha");
  assert.equal(detail.summary.completedAttempts, 2);
  assert.equal(detail.summary.correctPoints, 3);
  assert.equal(detail.summary.totalPoints, 4);
  assert.equal(detail.summary.accuracy, 0.75);
  assert.equal(detail.summary.totalPracticeSeconds, 180);
  assert.equal(detail.summary.byTask.ctw.completedAttempts, 2);
  assert.equal(detail.summary.byTask.rdl.completedAttempts, 0);
  assert.deepEqual(detail.attempts.map((attempt) => attempt.attemptId), ["w-rdl", "a-ctw-a", "a-ctw-b"]);
  assert.equal(detail.attempts[0].kind, "wrongbook");
  assert.equal(detail.attempts[0].scope, "today");
  assert.equal(detail.attempts.find((attempt) => attempt.attemptId === "a-ctw-a").itemDisplayName, "套题001");
  assert.equal(detail.attempts.find((attempt) => attempt.attemptId === "a-ctw-b").itemDisplayName, "套题002");
});

test("dashboard activity merges Reading and Writing newest-first with domain labels", () => {
  const activity = buildTeacherDashboardActivity({
    writing: [
      { attemptId: "w-1", studentId: "student-1", title: "套题001", submittedAt: "2026-06-01T10:00:00Z" }
    ],
    reading: [
      { attemptId: "r-1", studentId: "student-1", taskType: "rdl", itemTitle: "题目001 · Library Notice", submittedAt: "2026-06-02T10:00:00Z" },
      { attemptId: "r-2", studentId: "student-2", taskType: "ctw", itemTitle: "套题001", submittedAt: "2026-05-31T10:00:00Z" }
    ],
    studentNames: new Map([["student-1", "陈笑语"], ["student-2", "李四"]])
  });

  assert.deepEqual(activity.map((item) => item.activityId), ["r-1", "w-1", "r-2"]);
  assert.equal(activity[0].domain, "reading");
  assert.equal(activity[0].domainLabel, "Reading");
  assert.equal(activity[0].taskLabel, "RDL");
  assert.equal(activity[0].studentName, "陈笑语");
  assert.equal(activity[1].domain, "writing");
  assert.equal(activity[1].domainLabel, "Writing");
  assert.equal(activity[1].taskLabel, "BAS");
  assert.equal(activity[2].taskLabel, "CTW");
});

test("dashboard activity respects the recent limit without mixing domains", () => {
  const reading = Array.from({ length: 5 }, (_, index) => ({
    attemptId: `r-${index}`,
    studentId: "student-1",
    taskType: "ctw",
    itemTitle: `套题00${index}`,
    submittedAt: `2026-06-0${index + 1}T10:00:00Z`
  }));
  const activity = buildTeacherDashboardActivity({
    writing: [],
    reading,
    studentNames: new Map(),
    limit: 2
  });
  assert.deepEqual(activity.map((item) => item.activityId), ["r-4", "r-3"]);
});

test("/api/teacher/stats splits roster scope from writing/BAS scope", () => {
  const stats = read("app/api/teacher/stats/route.ts");
  assert.match(stats, /const scopedStudentIds = await listVisibleStudentIds\(db, actor\)/);
  assert.match(stats, /listTeacherStudentDomainBindings\(db, actor\)/);
  assert.match(stats, /const hasWritingDomain = teacherDomains\.includes\("writing"\)/);
  assert.match(stats, /const writingStudentIds = hasWritingDomain/);
  assert.match(stats, /fetchRowsForStudentIds<ProfileRow>\(scopedStudentIds/);
  assert.match(stats, /fetchRowsForStudentIds<AttemptRow>\(writingStudentIds/);
  assert.match(stats, /fetchRowsForStudentIds<AnswerRow>\(writingStudentIds/);
  assert.doesNotMatch(stats, /fetchRowsForStudentIds<AttemptRow>\(scopedStudentIds/);
  assert.doesNotMatch(stats, /fetchRowsForStudentIds<AnswerRow>\(scopedStudentIds/);
  assert.match(stats, /domains: studentDomains\.get\(studentId\) \?\? \[\]/);
  assert.match(stats, /teacherDomains,/);
  assert.doesNotMatch(stats, /owner_id/);
});

test("reading-only teachers never load BAS question metadata through teacher stats", () => {
  const stats = read("app/api/teacher/stats/route.ts");
  const basBlock = stats.match(/hasWritingDomain\s*\?\s*Promise\.all\(\[[\s\S]*?\]\)\s*:\s*null/)?.[0] ?? "";
  assert.match(basBlock, /from\("questions"\)/);
  assert.match(basBlock, /from\("practice_items"\)/);
  assert.match(basBlock, /from\("practice_item_sources"\)/);
});

test("/api/teacher/dashboard is teacher-only, lightweight, and binding-scoped", () => {
  const dashboard = read("app/api/teacher/dashboard/route.ts");
  assert.match(dashboard, /requireTeacherOnly\(bearerToken\(request\)\)/);
  assert.match(dashboard, /status: 403/);
  assert.match(dashboard, /listTeacherStudentDomainBindings/);
  assert.match(dashboard, /from\("reading_attempts"\)/);
  assert.match(dashboard, /from\("attempts"\)/);
  assert.match(dashboard, /buildTeacherDashboardActivity/);
  assert.match(dashboard, /"Cache-Control": "no-store"|Cache-Control[\s\S]{0,30}"no-store"/);
  assert.doesNotMatch(dashboard, /attempt_answers|reading_attempt_answers|reading_full_set/);
});

test("student Reading detail API requires a reading binding and reuses Reading stats", () => {
  const route = read("app/api/teacher/students/[studentId]/reading/route.ts");
  assert.match(route, /requireTeacherOnly\(bearerToken\(request\)\)/);
  assert.match(route, /canAccessStudentDomain\([\s\S]*"reading"/);
  assert.match(route, /buildTeacherStudentReadingDetail/);
  assert.match(route, /from\("reading_attempts"\)/);
  assert.match(route, /from\("reading_wrongbook_attempts"\)/);
  assert.doesNotMatch(route, /from\("attempts"\)|from\("attempt_answers"\)/);
  assert.doesNotMatch(route, /correct_option_id|correct_anchor_id|correct_sentence_id|missing_text|student_answer/);

  const lib = read("lib/reading/teacherStats.ts");
  assert.match(lib, /buildTeacherReadingStats\(/);
  assert.match(lib, /buildReadingHistoryPayload\(/);
});

test("Phase 6: navigation never hides Teacher entries by binding domain", () => {
  const shell = read("components/teacher/TeacherAppShell.tsx");
  assert.doesNotMatch(shell, /teacherDomains/);
  assert.doesNotMatch(shell, /item\.domain/);
  assert.match(shell, /if \(role === "admin"\) return !item\.teacherOnly;/);
  assert.match(shell, /return !item\.adminOnly;/);
  assert.match(shell, /href: "\/teacher\/reading\/statistics"/);
  assert.match(shell, /href: "\/teacher\/writing\/assignments"/);
  assert.match(shell, /href: "\/teacher\/writing\/reviews"/);
  assert.doesNotMatch(shell, /reading_teacher/);
  assert.doesNotMatch(shell, /profile\.role/);
});

test("Phase 6: teacher dashboard renders the fixed management entries for every teacher", () => {
  const dashboard = read("components/TeacherDashboard.tsx");
  assert.match(dashboard, /TEACHER_DASHBOARD_CACHE_KEY/);
  assert.match(dashboard, /loadTeacherDashboardPayload/);
  assert.doesNotMatch(dashboard, /teacherDomains\.includes/);
  assert.match(dashboard, /href="\/teacher\/writing\/assignments"/);
  assert.match(dashboard, /href="\/teacher\/writing\/reviews"/);
  assert.match(dashboard, /href="\/teacher\/reading\/statistics"/);
  assert.match(dashboard, /href="\/teacher\/sets"/);
  assert.match(dashboard, /TeacherStudentReadingSection/);
  assert.match(dashboard, /该学生不在你的写作教学范围内，无法查看 BAS 练习记录。/);
  assert.match(dashboard, /该学生不在你的写作教学范围内，无法查看 BAS 答题记录。/);
  assert.match(dashboard, /const hasWritingDomain = Boolean\(student\?\.domains\.includes\("writing"\)\)/);
});

test("student summary gates BAS metrics and history behind the writing binding", () => {
  const dashboard = read("components/TeacherDashboard.tsx");
  assert.match(dashboard, /const hasWriting = domains\.includes\("writing"\)/);
  assert.match(dashboard, /const attempts = \(stats\?\.attempts \?\? \[\]\)\.filter\(\n\s*\(attempt\) => hasWriting && attempt\.studentId === studentId\n\s*\)/);
  assert.match(dashboard, /hasWriting \? \(\n\s*<section className="grid gap-4">/);
});

test("Reading student detail UI reuses the shared Reading statistics payloads", () => {
  const component = read("components/teacher/TeacherStudentReading.tsx");
  assert.match(component, /TeacherStudentReadingDetailPayload/);
  assert.match(component, /\/api\/teacher\/students\/\$\{encodeURIComponent\(studentId\)\}\/reading/);
  assert.match(component, /TeacherMetricCard/);
  assert.match(component, /TeacherAccuracyBar/);
  assert.match(component, /错题订正/);
  assert.doesNotMatch(component, /sentence_template|correct_order_text|submitted_order_text/);
});

test("binding updates invalidate dashboard, student overview, and student Reading caches", () => {
  const matrix = read("lib/cacheInvalidation.ts");
  assert.match(matrix, /TEACHER_BINDING_UPDATED:[\s\S]*teacherDashboard/);
  assert.match(matrix, /TEACHER_BINDING_UPDATED:[\s\S]*teacherStudentOverview/);
  assert.match(matrix, /TEACHER_BINDING_UPDATED:[\s\S]*teacherReadingStatistics/);

  const cache = read("components/TeacherDataCache.tsx");
  assert.match(cache, /TEACHER_DASHBOARD_CACHE_KEY = "teacher:dashboard:v1"/);
  assert.match(cache, /TEACHER_STUDENT_OVERVIEW_CACHE_KEY = "teacher:student-overview:v1"/);
  assert.match(cache, /TEACHER_STUDENT_READING_CACHE_PREFIX = "teacher:student-reading"/);
  assert.match(cache, /case "teacherDashboard":[\s\S]*TEACHER_DASHBOARD_CACHE_KEY/);
  assert.match(cache, /case "teacherStudentOverview":[\s\S]*TEACHER_STUDENT_OVERVIEW_CACHE_KEY/);
  assert.match(cache, /case "teacherReadingStatistics":[\s\S]*TEACHER_STUDENT_READING_CACHE_PREFIX/);
  assert.match(cache, /TEACHER_STATS_CACHE_SCHEMA_VERSION = 3/);
});

test("Phase 2/3 permissions stay intact for assignment and admin boundaries", () => {
  const accountAccess = read("lib/accountAccess.ts");
  assert.match(accountAccess, /listVisibleStudentIds/);
  assert.match(accountAccess, /"teacher_student_bindings"/);
  assert.doesNotMatch(accountAccess, /\.eq\("owner_id",/);
  assert.match(accountAccess, /listTeacherStudentDomainBindings/);

  const readingRoute = read("app/api/teacher/reading/statistics/route.ts");
  assert.match(readingRoute, /requireTeacherOnly\(token\)/);
  assert.match(readingRoute, /listVisibleStudentIds\([\s\S]*"reading"/);

  const adminBindings = read("app/api/admin/student-bindings/route.ts");
  assert.match(adminBindings, /requireAdmin/);
  assert.doesNotMatch(adminBindings, /requireTeacherOnly/);
});
