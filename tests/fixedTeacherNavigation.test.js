const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const TEACHER_NAV_ENTRIES = [
  ["/teacher/dashboard", "首页"],
  ["/teacher/students", "账号"],
  ["/teacher/writing/assignments", "作业管理"],
  ["/teacher/writing/reviews", "写作批改"],
  ["/teacher/question-bank", "查看所有套题"]
];

const ADMIN_NAV_ENTRIES = [
  ["/teacher/sets", "套题统计"],
  ["/teacher/reading/statistics", "阅读统计"]
];

test("Case 1/2/3: every ordinary Teacher sees the same complete navigation", () => {
  const shell = read("components/teacher/TeacherAppShell.tsx");
  for (const [href, label] of TEACHER_NAV_ENTRIES) {
    assert.match(shell, new RegExp(`href: "${href.replace(/\//g, "\\/")}"`), `${href} must stay in the sidebar`);
    assert.match(shell, new RegExp(`label: "${label}"`), `${label} must keep its sidebar label`);
  }
  // Teaching entries are teacher-only, so Admin keeps its Phase 3/4 navigation.
  for (const href of [
    "/teacher/writing/assignments",
    "/teacher/writing/reviews"
  ]) {
    const block = shell.match(new RegExp(`href: "${href.replace(/\//g, "\\/")}"[\\s\\S]*?\\n  \\}`))?.[0] ?? "";
    assert.match(block, /teacherOnly: true/, `${href} must stay teacherOnly`);
  }
  assert.match(shell, /href: "\/admin\/student-bindings"/);
  assert.match(shell, /adminOnly: true/);
});

test("whole-student statistics are Admin-only navigation entries", () => {
  const shell = read("components/teacher/TeacherAppShell.tsx");
  for (const [href, label] of ADMIN_NAV_ENTRIES) {
    const block = shell.match(new RegExp(`href: "${href.replace(/\//g, "\\/")}"[\\s\\S]*?\\n  \\}`))?.[0] ?? "";
    assert.ok(block, `${href} must stay in the sidebar`);
    assert.match(block, /adminOnly: true/, `${href} must be Admin-only`);
    assert.match(block, new RegExp(`label: "${label}"`), `${label} must keep its sidebar label`);
  }
});

test("Teacher navigation never depends on binding domains or dashboards", () => {
  const shell = read("components/teacher/TeacherAppShell.tsx");
  assert.doesNotMatch(shell, /teacherDomains/);
  assert.doesNotMatch(shell, /hasReading|hasWriting/);
  assert.doesNotMatch(shell, /item\.domain/);
  assert.doesNotMatch(shell, /loadTeacherDashboardPayload|TEACHER_DASHBOARD_CACHE_KEY/);
  assert.match(shell, /if \(role === "admin"\) return !item\.teacherOnly;/);
  assert.match(shell, /return !item\.adminOnly;/);
});

test("Teacher home no longer renders management entry cards", () => {
  const dashboard = read("components/TeacherDashboard.tsx");
  assert.doesNotMatch(dashboard, /<TeacherSectionTitle>管理入口<\/TeacherSectionTitle>/);
  const home = read("components/teacher/TeacherHomeDashboard.tsx");
  assert.doesNotMatch(home, /管理入口/);
  assert.doesNotMatch(home, /数据概览/);
  assert.doesNotMatch(home, /总套题数|总题目数|今日新增练习|已完成阅读练习|今日新增阅读练习/);
});

test("Teacher home shows only the two core numbers plus attention and activity regions", () => {
  const home = read("components/teacher/TeacherHomeDashboard.tsx");
  assert.match(home, /总学生数/);
  assert.match(home, /待批改/);
  assert.match(home, /作业提醒/);
  assert.match(home, /即将到期|due_soon/);
  assert.match(home, /已逾期|overdue/);
  assert.match(home, /近 3 天未活跃学生/);
  assert.match(home, /近期动态/);
  assert.doesNotMatch(home, /正确率|成绩|练习次数|趋势|风险/);
  const inactive = read("app/teacher/inactive-students/page.tsx");
  assert.match(inactive, /TeacherInactiveStudents/);
  assert.match(inactive, /AdminOnly|TeacherOnly/);
});

test("Admin home rules stay unchanged from Phase 3/4", () => {
  const shell = read("components/teacher/TeacherAppShell.tsx");
  assert.match(shell, /if \(role === "admin"\) return !item\.teacherOnly;/);
  assert.match(shell, /return !item\.adminOnly;/);
  const dashboard = read("components/TeacherDashboard.tsx");
  assert.match(dashboard, /export function AdminPlatformHome/);
  assert.match(dashboard, /title="教师绑定"/);
  assert.doesNotMatch(dashboard, /历史作业转移/);
  assert.match(dashboard, /作业管理、写作批改、阅读统计等教学工作流仅对普通教师开放。/);
});

test("Phase 5 domain isolation stays in the student detail views", () => {
  const dashboard = read("components/TeacherDashboard.tsx");
  assert.match(dashboard, /TeacherStudentPracticeWorkspace/);
  assert.doesNotMatch(dashboard, /该学生不在你的写作教学范围内/);

  const component = read("components/teacher/TeacherStudentPracticeSection.tsx");
  assert.match(component, /payload\.reading \? \(/);
  assert.match(component, /payload\.writing \? \(/);
  assert.match(component, /DomainChip domain="reading"/);
  assert.match(component, /DomainChip domain="writing"/);

  const route = read("app/api/teacher/students/[studentId]/practice/route.ts");
  assert.match(route, /canAccessStudentDomain\(db, actor, studentId, "reading"\)/);
  assert.match(route, /canAccessStudentDomain\(db, actor, studentId, "writing"\)/);
  assert.match(route, /if \(!readingAllowed && !writingAllowed\)/);

  const setRoute = read("app/api/teacher/students/[studentId]/bas/sets/[setId]/route.ts");
  assert.match(setRoute, /canAccessStudentDomain\(db, \{ userId: auth\.userId, role: auth\.role \}, studentId, "writing"\)/);
  const answerRoute = read("app/api/teacher/students/[studentId]/answers/[attemptAnswerId]/route.ts");
  assert.match(answerRoute, /canAccessStudentDomain\(db, \{ userId: auth\.userId, role: auth\.role \}, studentId, "writing"\)/);
});
