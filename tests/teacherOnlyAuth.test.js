const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const ROOT = join(__dirname, "..");

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

function assertTeacherOnly(source, label) {
  assert.match(source, /requireTeacherOnly/, `${label} must call requireTeacherOnly`);
  const inline403 = /auth\.error === "Forbidden" \? 403 : 401/;
  const viaAssert = /assertWritingReviewTeacher/;
  assert.ok(
    inline403.test(source) || viaAssert.test(source),
    `${label} must reach 403 for "Forbidden" (inline ternary or assertWritingReviewTeacher)`
  );
}

test("Phase 3 case 1-2: writing assignment APIs are teacher-only and 403 for Admin", () => {
  const helper = read("lib/writingAssignmentsServer.ts");
  assert.match(helper, /requireTeacherOnly/);
  assert.match(helper, /auth\.error === "Forbidden" \? 403 : 401/);

  const routes = [
    "app/api/teacher/writing/assignments/route.ts",
    "app/api/teacher/writing/assignments/[assignmentId]/route.ts",
    "app/api/teacher/writing/assignments/batches/[batchId]/route.ts",
    "app/api/teacher/writing/assignments/students/route.ts",
    "app/api/teacher/writing/assignments/avatars/route.ts",
    "app/api/teacher/writing/assignments/questions/route.ts"
  ];
  for (const routePath of routes) {
    const source = read(routePath);
    assert.match(source, /requireWritingAssignmentTeacher/, `${routePath} must gate through the shared helper`);
  }
});

test("Phase 3 case 3-4: writing review and AI APIs are teacher-only and 403 for Admin", () => {
  const workspaceHeader = read("lib/writingReviewWorkspaceServer.ts");
  assert.match(workspaceHeader, /"Forbidden" \? 403 : 401/, "assertWritingReviewTeacher must reach 403 for Forbidden");

  const reviewRoutes = [
    "app/api/teacher/writing/reviews/route.ts",
    "app/api/teacher/writing/reviews/[attemptId]/route.ts",
    "app/api/teacher/writing/reviews/[attemptId]/generate-ai/route.ts",
    "app/api/teacher/writing/reviews/[attemptId]/regenerate-ai/route.ts",
    "app/api/teacher/writing/reviews/[attemptId]/publish/route.ts",
    "app/api/teacher/writing/reviews/[attemptId]/feedback/[feedbackId]/regenerate/route.ts",
    "app/api/teacher/writing/reviews/ai-logs/route.ts",
    "app/api/teacher/writing/reviews/ai-logs/[logId]/route.ts"
  ];
  for (const routePath of reviewRoutes) {
    assertTeacherOnly(read(routePath), routePath);
  }
});

test("Phase 3 case 5: whole-student statistics are Admin-only and closed to Teacher", () => {
  const reading = read("app/api/teacher/reading/statistics/route.ts");
  assert.match(reading, /requireAdmin\(token\)/);
  assert.doesNotMatch(reading, /requireTeacherOnly/);
  assert.match(reading, /status: auth\.role \? 403 : 401/);
  assert.match(reading, /listVisibleStudentIds/);
  assert.match(reading, /"reading"/);

  const stats = read("app/api/teacher/stats/route.ts");
  assert.match(stats, /requireAdmin\(token\)/);
  assert.doesNotMatch(stats, /requireTeacherOnly/);
  assert.match(stats, /auth\.role \? 403 : 401/);
});

test("Phase 3 case 6: admin platform management stays available to Admin", () => {
  const students = read("app/api/teacher/students/route.ts");
  assert.match(students, /requireUserWithRole\(bearerToken\(request\), "teacher"\)/, "students remains requireUserWithRole (account management)");
  assert.match(students, /admin|owner_id|student_account_limit/, "students keeps its admin account-management branch");

  const bindings = read("app/api/admin/student-bindings/route.ts");
  assert.match(bindings, /requireAdmin/);
  assert.doesNotMatch(bindings, /requireTeacherOnly/);
  assert.match(bindings, /teacher_student_bindings/);

  const teachers = read("app/api/admin/teachers/route.ts");
  assert.match(teachers, /requireAdmin/);
  assert.doesNotMatch(teachers, /requireTeacherOnly/);
});

test("Phase 3 case 7: Admin keeps account-only student list via dedicated admin endpoint", () => {
  const adminStudents = read("app/api/admin/students/route.ts");
  assert.match(adminStudents, /requireAdmin/);
  assert.doesNotMatch(adminStudents, /writing_assignments|writing_attempts|reading_attempts/);
  assert.match(adminStudents, /eq\("role", "student"\)/);

  const adminList = read("components/admin/AdminStudents.tsx");
  assert.match(adminList, /\/api\/admin\/students/);
  assert.match(adminList, /AccountTabs/);
});

test("Phase 3 case 8: teacher operational pages render only for actual teachers", () => {
  const pages = [
    "app/teacher/writing/assignments/page.tsx",
    "app/teacher/writing/assignments/new/page.tsx",
    "app/teacher/writing/assignments/[assignmentId]/page.tsx",
    "app/teacher/writing/assignments/[assignmentId]/edit/page.tsx",
    "app/teacher/writing/assignments/batches/[batchId]/page.tsx",
    "app/teacher/writing/reviews/page.tsx",
    "app/teacher/writing/reviews/logs/page.tsx",
    "app/teacher/writing/reviews/[attemptId]/page.tsx",
    "app/teacher/inactive-students/page.tsx",
    "app/teacher/students/[studentId]/page.tsx",
    "app/teacher/students/[studentId]/details/[setId]/page.tsx",
    "app/teacher/students/[studentId]/answers/[attemptAnswerId]/page.tsx"
  ];
  for (const pagePath of pages) {
    const source = read(pagePath);
    assert.match(source, /<TeacherOnly>/, `${pagePath} must be wrapped in TeacherOnly`);
    assert.match(source, /<\/TeacherOnly>/, `${pagePath} must close TeacherOnly`);
  }

  // Whole-student statistics pages stay open to Admin and blocked for Teacher.
  for (const pagePath of [
    "app/teacher/reading/statistics/page.tsx",
    "app/teacher/sets/page.tsx",
    "app/teacher/sets/[setId]/page.tsx",
    "app/teacher/sets/[setId]/questions/[questionId]/page.tsx"
  ]) {
    const source = read(pagePath);
    assert.match(source, /<AdminOnly>/, `${pagePath} must be wrapped in AdminOnly`);
    assert.match(source, /<\/AdminOnly>/, `${pagePath} must close AdminOnly`);
    assert.doesNotMatch(source, /TeacherOnly/, `${pagePath} must not stay TeacherOnly`);
  }

  const shell = read("components/teacher/TeacherAppShell.tsx");
  assert.match(shell, /teacherOnly/, "nav items must carry teacherOnly flag");
  assert.match(shell, /adminOnly/, "admin reporting entries must carry adminOnly flag");
  assert.match(shell, /!item\.teacherOnly/, "shell must hide teaching entries for Admin");
  assert.match(shell, /!item\.adminOnly/, "shell must keep admin-only entries for Admin");
});

test("Phase 3 case 9: no production SQL migration introduced in Phase 3 and legacy owner_id untouched", () => {
  const accountAccess = read("lib/accountAccess.ts");
  assert.doesNotMatch(accountAccess, /\.eq\("owner_id",/, "profiles.owner_id is never used as a query filter");
  assert.doesNotMatch(accountAccess, /\.from\("writing_assignments"\)[\s\S]*\.(update|delete)/, "accountAccess never mutates writing data");

  const bindingsSql = read("supabase/teacher_student_bindings.sql");
  assert.match(bindingsSql, /create table if not exists public\.teacher_student_bindings/);

  const gate = read("lib/auth.ts");
  assert.match(gate, /Admin is a platform manager/);
  assert.match(gate, /account\.role !== "teacher"/);
});