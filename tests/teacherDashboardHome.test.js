const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createMockSupabase } = require("./fixtures/mockSupabase.js");
const {
  aggregateTeacherDashboardReminders,
  sortTeacherDashboardReminders,
  TEACHER_DASHBOARD_REMINDER_LIMIT
} = require("../lib/teacherDashboard.ts");
const {
  findInactiveStudentIds,
  loadLatestActivityByStudent,
  loadInactiveStudentsWithLastActivity
} = require("../lib/teacherStudentActivity.server.ts");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("reminder priority: overdue first (most recent first), then upcoming (soonest first)", () => {
  const reminders = [
    { assignmentId: "a", studentId: "s1", studentName: "S1", dueAt: "2026-09-22T20:00:00Z", status: "due_soon" },
    { assignmentId: "b", studentId: "s2", studentName: "S2", dueAt: "2026-09-20T10:00:00Z", status: "overdue" },
    { assignmentId: "c", studentId: "s3", studentName: "S3", dueAt: "2026-09-22T14:00:00Z", status: "due_soon" },
    { assignmentId: "d", studentId: "s4", studentName: "S4", dueAt: "2026-09-21T09:00:00Z", status: "overdue" }
  ];
  const sorted = sortTeacherDashboardReminders(reminders);
  assert.deepEqual(
    sorted.map((reminder) => reminder.assignmentId),
    ["d", "b", "c", "a"]
  );
});

test("reminder list is capped so it can never stretch the homepage", () => {
  const reminders = Array.from({ length: 40 }, (_, index) => ({
    assignmentId: `a-${index}`,
    studentId: `s-${index}`,
    studentName: `S-${index}`,
    dueAt: `2026-09-${String((index % 20) + 1).padStart(2, "0")}T10:00:00Z`,
    status: index % 2 === 0 ? "overdue" : "due_soon"
  }));
  const sorted = sortTeacherDashboardReminders(reminders);
  assert.equal(sorted.length, TEACHER_DASHBOARD_REMINDER_LIMIT);
  assert.ok(sorted.every((reminder) => reminder.status === "overdue"));
});

test("homepage reminders are student-level: one per student and status, never assignment names", () => {
  const reminders = [
    { assignmentId: "old-overdue", studentId: "s1", dueAt: "2026-09-18T10:00:00Z", status: "overdue" },
    { assignmentId: "new-overdue", studentId: "s1", dueAt: "2026-09-20T10:00:00Z", status: "overdue" },
    { assignmentId: "far-soon", studentId: "s1", dueAt: "2026-09-22T23:00:00Z", status: "due_soon" },
    { assignmentId: "near-soon", studentId: "s1", dueAt: "2026-09-22T18:00:00Z", status: "due_soon" },
    { assignmentId: "s2-overdue", studentId: "s2", dueAt: "2026-09-19T10:00:00Z", status: "overdue" }
  ];
  const names = new Map([["s1", "学生一"], ["s2", "学生二"]]);
  const aggregated = aggregateTeacherDashboardReminders(reminders, names);

  assert.deepEqual(
    aggregated.map((reminder) => [reminder.studentId, reminder.status, reminder.dueAt]),
    [
      ["s1", "overdue", "2026-09-20T10:00:00Z"],
      ["s2", "overdue", "2026-09-19T10:00:00Z"],
      ["s1", "due_soon", "2026-09-22T18:00:00Z"]
    ]
  );
  assert.deepEqual(aggregated.map((reminder) => reminder.studentName), ["学生一", "学生二", "学生一"]);
  assert.ok(aggregated.every((reminder) => !("assignmentId" in reminder)));
});

function activityTables() {
  return {
    attempts: [
      { attempt_id: "bas-a1", student_id: "student-a", submitted_at: "2026-09-22T08:00:00Z" },
      { attempt_id: "bas-b-old", student_id: "student-b", submitted_at: "2026-08-01T08:00:00Z" }
    ],
    writing_attempts: [
      { attempt_id: "w-draft-d", user_id: "student-d", status: "draft", submitted_at: null },
      { attempt_id: "w-a-draft", user_id: "student-a", status: "draft", submitted_at: null }
    ],
    reading_attempts: [
      { attempt_id: "r-b1", student_id: "student-b", status: "submitted", submitted_at: "2026-09-01T09:00:00Z" },
      { attempt_id: "r-c-draft", student_id: "student-c", status: "draft", submitted_at: null }
    ]
  };
}

test("inactive students ignore drafts and students active inside the 3-day window", async () => {
  const db = createMockSupabase(activityTables());
  const inactive = await findInactiveStudentIds(
    db,
    ["student-a", "student-b", "student-c", "student-d"],
    "2026-09-19T12:00:00Z"
  );
  assert.deepEqual(inactive, ["student-b", "student-c", "student-d"]);
});

test("latest activity uses the newest submitted record per student and null for never-practiced", async () => {
  const db = createMockSupabase(activityTables());
  const latest = await loadLatestActivityByStudent(db, ["student-b", "student-c"]);
  assert.equal(latest.get("student-b"), "2026-09-01T09:00:00Z");
  assert.equal(latest.get("student-c"), undefined);
});

test("inactive students with last activity keeps null for never-practiced students", async () => {
  const db = createMockSupabase(activityTables());
  const result = await loadInactiveStudentsWithLastActivity(
    db,
    ["student-a", "student-b", "student-c", "student-d"],
    new Date("2026-09-22T12:00:00Z")
  );
  assert.deepEqual(result.inactiveStudentIds, ["student-b", "student-c", "student-d"]);
  assert.equal(result.lastActivityByStudent.get("student-b"), "2026-09-01T09:00:00Z");
  assert.equal(result.lastActivityByStudent.get("student-c"), undefined);
});

test("pending review count is computed with database counts, not loaded attempt rows", () => {
  const lib = read("lib/teacherDashboardServer.ts");
  assert.match(lib, /count: "exact", head: true/);
  assert.match(lib, /writing_reviews!inner/);
  assert.match(lib, /eq\("writing_reviews\.status", "published"\)/);
  assert.match(lib, /selfSubmitted \+ assignmentSubmitted - selfPublished - assignmentPublished/);
});

test("assignment reminders only read assignment, recipient, and completion fields", () => {
  const lib = read("lib/teacherDashboardServer.ts");
  const reminderBlock = lib.match(
    /export async function loadTeacherAssignmentReminders[\s\S]*?\n\}/
  )?.[0] ?? "";
  assert.match(reminderBlock, /select\("assignment_id,due_at"\)/);
  assert.match(reminderBlock, /select\("assignment_id,student_id"\)/);
  assert.match(reminderBlock, /select\("assignment_id,user_id"\)/);
  assert.doesNotMatch(reminderBlock, /question_snapshot|response_text|review|answer/);
  assert.doesNotMatch(reminderBlock, /loadStudentNames\([\s\S]*visibleStudentIds/);
});

test("Reading question bank uses the canonical inventory and never student attempts or statistics", () => {
  const route = read("app/api/teacher/question-bank/reading/route.ts");
  const answerKey = read("lib/teacherReadingAnswerKey.server.ts");
  assert.match(route, /from\("reading_logical_items"\)/);
  assert.match(route, /loadStudentReadingPractice/);
  assert.match(route, /skipRdlAssetVerification: true/);
  assert.match(route, /buildTeacherReadingAnswerKey/);
  assert.match(route, /readingCatalogDisplayNumbers/);
  assert.match(route, /readAllSupabaseRows/);
  assert.match(route, /order\("first_seen_date"/);
  assert.match(route, /order\("logical_item_id"/);
  assert.doesNotMatch(
    route + answerKey,
    /reading_attempts|reading_full_set|teacher\/reading\/statistics|student_answer|attempt_answer_id/
  );
  assert.match(answerKey, /from\("reading_questions"\)/);
  assert.match(answerKey, /from\("reading_ctw_slots"\)/);
  assert.match(answerKey, /buildReadingAnswerKeyPresentations/);

  const ui = read("components/teacher/TeacherReadingQuestionBank.tsx");
  assert.match(ui, /PracticeSetCatalogList/);
  assert.match(ui, /ReadingCatalogPagination/);
  assert.match(ui, /STUDENT_PRACTICE_ICONS\[item\.module\]/);
  assert.match(ui, /formatOccurrenceDates/);
  assert.match(ui, /ReadingReadonlyReviewShell/);
  assert.match(ui, /answerKeyOnly/);
  assert.match(ui, /buildTeacherReadingAnswerKeyView/);
  assert.doesNotMatch(ui, /ReadingCatalogStatusBadge|ReadingRetakeButton|开始练习|继续练习|查看结果/);
  assert.match(ui, /reading:.*\$\{module\}/);

  const tabs = read("components/TeacherQuestionBank.tsx");
  for (const module of ["ctw", "rdl", "rap"]) {
    assert.match(tabs, new RegExp(`READING_PRODUCT_NAMES\\.${module}`), `${module} tab must render`);
  }
  assert.match(tabs, /TeacherReadingQuestionBankCatalog/);
  assert.match(tabs, /STUDENT_PRACTICE_ICONS\[item\.task_type\]/);
});

test("teacher home makes no dashboard aggregation request and only reuses the student list", () => {
  const home = read("components/teacher/TeacherHomeDashboard.tsx");
  const workHome = home.match(/export function TeacherWorkHome[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(workHome.length > 0, "TeacherWorkHome must exist");
  assert.match(workHome, /TeacherStudentOverviewList/);
  assert.doesNotMatch(workHome, /loadTeacherDashboardPayload|TEACHER_DASHBOARD_CACHE_KEY/);
  assert.doesNotMatch(workHome, /fetch\(|\/api\/teacher\/dashboard|\/api\/teacher\/stats|\/api\/teacher\/reading\/statistics/);

  const list = read("components/teacher/TeacherStudentOverview.tsx");
  assert.match(list, /\/api\/teacher\/students\/overview/);
  assert.match(list, /TEACHER_STUDENT_OVERVIEW_CACHE_KEY/);

  // The inactive list is still served by its own page and endpoint.
  assert.match(home, /\/api\/teacher\/inactive-students/);
  const inactiveRoute = read("app/api/teacher/inactive-students/route.ts");
  assert.match(inactiveRoute, /requireTeacherOnly/);
  assert.match(inactiveRoute, /loadInactiveStudentsWithLastActivity/);
  assert.doesNotMatch(inactiveRoute, /reading_attempts|writing_attempts|from\("attempts"\)/);
});

test("whole-student statistics APIs reject Teacher access", () => {
  const stats = read("app/api/teacher/stats/route.ts");
  assert.match(stats, /requireAdmin\(token\)/);
  assert.doesNotMatch(stats, /requireTeacherOnly/);
  const readingStats = read("app/api/teacher/reading/statistics/route.ts");
  assert.match(readingStats, /requireAdmin\(token\)/);
  assert.doesNotMatch(readingStats, /requireTeacherOnly/);
});

test("review mutations invalidate only their own workspace and home counts precisely", () => {
  const cache = read("components/TeacherDataCache.tsx");
  assert.match(cache, /case "teacherWritingReviewWorkspace":[\s\S]*event\.attemptId[\s\S]*TEACHER_WRITING_REVIEW_WORKSPACE_CACHE_PREFIX\}:\$\{event\.attemptId\}/);
  const matrix = read("lib/cacheInvalidation.ts");
  assert.match(matrix, /WRITING_REVIEW_PUBLISHED:[\s\S]*teacherDashboard/);
  assert.match(matrix, /WRITING_ATTEMPT_SUBMITTED:[\s\S]*teacherDashboard/);
  assert.match(matrix, /ASSIGNMENT_UPDATED:[\s\S]*teacherDashboard/);
  const updatedBlock = matrix.match(/WRITING_REVIEW_UPDATED:[\s\S]*?\],\n  WRITING_REVIEW_PUBLISHED/)?.[0] ?? "";
  assert.ok(updatedBlock.length > 0, "WRITING_REVIEW_UPDATED block must exist");
  assert.doesNotMatch(updatedBlock, /teacherDashboard|teacherAssignments/);
});

test("review list and question bank reuse cached data instead of refetching on every mount", () => {
  assert.doesNotMatch(read("components/teacher/TeacherWritingReviewList.tsx"), /refreshOnMount/);
  assert.doesNotMatch(read("components/TeacherQuestionBank.tsx"), /refreshOnMount/);
});

test("teacher dashboard and stats pages are wrapped for the right role", () => {
  assert.match(read("app/teacher/dashboard/page.tsx"), /TeacherHome/);
  const inactive = read("app/teacher/inactive-students/page.tsx");
  assert.match(inactive, /<TeacherOnly>/);
  const readingStats = read("app/teacher/reading/statistics/page.tsx");
  assert.match(readingStats, /<AdminOnly>/);
  const sets = read("app/teacher/sets/page.tsx");
  assert.match(sets, /<AdminOnly>/);
});
