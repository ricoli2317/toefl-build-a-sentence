const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const TEACHER_NAV_ENTRIES = [
  ["/teacher/dashboard", "首页"],
  ["/teacher/students", "账号"],
  ["/teacher/sets", "套题统计"],
  ["/teacher/reading/statistics", "阅读统计"],
  ["/teacher/writing/assignments", "作业管理"],
  ["/teacher/writing/reviews", "写作批改"],
  ["/teacher/question-bank", "查看所有套题"]
];

test("Case 1/2/3: every ordinary Teacher sees the same complete navigation", () => {
  const shell = read("components/teacher/TeacherAppShell.tsx");
  for (const [href, label] of TEACHER_NAV_ENTRIES) {
    assert.match(shell, new RegExp(`href: "${href.replace(/\//g, "\\/")}"`), `${href} must stay in the sidebar`);
    assert.match(shell, new RegExp(`label: "${label}"`), `${label} must keep its sidebar label`);
  }
  // Teacher entries are teacher-only, so Admin keeps its Phase 3/4 navigation.
  for (const href of [
    "/teacher/sets",
    "/teacher/reading/statistics",
    "/teacher/writing/assignments",
    "/teacher/writing/reviews"
  ]) {
    const block = shell.match(new RegExp(`href: "${href.replace(/\//g, "\\/")}"[\\s\\S]*?\\n  \\}`))?.[0] ?? "";
    assert.match(block, /teacherOnly: true/, `${href} must stay teacherOnly`);
  }
  assert.match(shell, /href: "\/admin\/student-bindings"/);
  assert.match(shell, /adminOnly: true/);
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

test("Case 1/2/3: the Teacher home shows every management entry without domain gating", () => {
  const dashboard = read("components/TeacherDashboard.tsx");
  const management = dashboard.match(
    /<TeacherSectionTitle>管理入口<\/TeacherSectionTitle>[\s\S]*?<TeacherSectionTitle>数据概览<\/TeacherSectionTitle>/
  )?.[0] ?? "";
  assert.ok(management.length > 0, "management section must exist");
  assert.doesNotMatch(management, /hasReading|hasWriting/);
  for (const [href, title] of [
    ["/teacher/students", "学生"],
    ["/teacher/sets", "套题统计"],
    ["/teacher/reading/statistics", "阅读统计"],
    ["/teacher/writing/assignments", "作业管理"],
    ["/teacher/writing/reviews", "写作批改"],
    ["/teacher/question-bank", "查看所有套题"]
  ]) {
    assert.match(management, new RegExp(`href="${href.replace(/\//g, "\\/")}"`), `${href} entry must render`);
    assert.match(management, new RegExp(`title="${title}"`), `${title} card must render`);
  }
});

test("Teacher home overview cards render zero instead of disappearing", () => {
  const dashboard = read("components/TeacherDashboard.tsx");
  const overview = dashboard.match(
    /<TeacherSectionTitle>数据概览<\/TeacherSectionTitle>[\s\S]*?<TeacherCard className="p-5 sm:p-6">/
  )?.[0] ?? "";
  assert.ok(overview.length > 0, "overview section must exist");
  assert.doesNotMatch(overview, /hasReading|hasWriting/);
  assert.match(overview, /总学生数/);
  assert.match(overview, /总套题数/);
  assert.match(overview, /总题目数/);
  assert.match(overview, /今日新增练习/);
  assert.match(overview, /已完成阅读练习/);
  assert.match(overview, /今日新增阅读练习/);
  assert.match(overview, /dashboard\?\.reading\?\.completedAttemptCount \?\? 0/);
});

test("Admin navigation rules stay unchanged from Phase 3/4", () => {
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
  assert.match(dashboard, /const hasWriting = domains\.includes\("writing"\)/);
  assert.match(dashboard, /hasWriting \? \(\n\s*<section className="grid gap-4">/);
  assert.match(dashboard, /该学生不在你的写作教学范围内，无法查看 BAS 练习记录。/);
  assert.match(dashboard, /该学生不在你的写作教学范围内，无法查看 BAS 答题记录。/);
});
