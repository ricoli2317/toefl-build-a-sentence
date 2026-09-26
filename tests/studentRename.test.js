const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { canManageStudent } = require("../lib/accountAccess.ts");
const {
  MAX_STUDENT_FULL_NAME_LENGTH,
  normalizeStudentFullName,
  renameStudentProfile,
  validateStudentFullName
} = require("../lib/studentProfileName.ts");
const {
  compareStudentSearchGroups,
  compareStudentSearchMetadata,
  createStudentSearchMetadata,
  studentSearchRank
} = require("../lib/studentSearch.ts");
const { buildTeacherStudentOverview } = require("../lib/teacherStudentOverview.ts");
const { getPreferredUserDisplayName } = require("../lib/userDisplayName.ts");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const STUDENT = "student-chen";
const TEACHER_READING = "teacher-reading";
const TEACHER_WRITING = "teacher-writing";

function tables() {
  return {
    profiles: [
      { id: TEACHER_READING, role: "teacher", is_active: true, email: "reading@bas.com", full_name: "阅读老师" },
      { id: TEACHER_WRITING, role: "teacher", is_active: true, email: "writing@bas.com", full_name: "写作老师" },
      { id: "teacher-none", role: "teacher", is_active: true, email: "none@bas.com", full_name: "无关老师" },
      { id: "teacher-owner", role: "teacher", is_active: true, email: "owner@bas.com", full_name: "旧 owner" },
      { id: "admin-1", role: "admin", is_active: true, email: "student@test.com", full_name: "平台管理员" },
      { id: STUDENT, role: "student", is_active: true, email: "chenxiaoming@bas.com", full_name: "陈小明", owner_id: "teacher-owner" },
      { id: "student-inactive", role: "student", is_active: false, email: "inactive@bas.com", full_name: "停用学生", owner_id: "teacher-owner" }
    ],
    teacher_student_bindings: [
      { binding_id: "b-reading", teacher_id: TEACHER_READING, student_id: STUDENT, domain: "reading" },
      { binding_id: "b-writing", teacher_id: TEACHER_WRITING, student_id: STUDENT, domain: "writing" }
    ]
  };
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

test("Teacher rename permission is binding-scoped and never falls back to owner_id", async () => {
  const db = createMockSupabase(tables());

  assert.equal(
    await canManageStudent(db, { userId: TEACHER_READING, role: "teacher" }, STUDENT),
    true
  );
  assert.equal(
    await canManageStudent(db, { userId: TEACHER_WRITING, role: "teacher" }, STUDENT),
    true
  );
  assert.equal(
    await canManageStudent(db, { userId: "teacher-none", role: "teacher" }, STUDENT),
    false
  );
  // profiles.owner_id still never grants teaching access.
  assert.equal(
    await canManageStudent(db, { userId: "teacher-owner", role: "teacher" }, STUDENT),
    false
  );
  assert.equal(
    await canManageStudent(db, { userId: "teacher-none", role: "teacher" }, "student-inactive"),
    false
  );
});

test("rename writes only profiles.full_name and keeps account, ownership, and bindings", async () => {
  const data = tables();
  const db = createMockSupabase(data);
  const profilesBefore = snapshot(data.profiles);
  const bindingsBefore = snapshot(data.teacher_student_bindings);

  const result = await renameStudentProfile(db, { studentId: STUDENT, fullName: "张小明" });
  assert.deepEqual(result, { studentId: STUDENT, displayName: "张小明" });

  const student = data.profiles.find((profile) => profile.id === STUDENT);
  const before = profilesBefore.find((profile) => profile.id === STUDENT);
  assert.equal(student.full_name, "张小明");
  assert.equal(student.email, before.email);
  assert.equal(student.owner_id, before.owner_id);
  assert.equal(student.role, before.role);
  assert.equal(student.is_active, before.is_active);
  // No other profile row and no binding row is touched.
  assert.deepEqual(
    data.profiles.filter((profile) => profile.id !== STUDENT),
    profilesBefore.filter((profile) => profile.id !== STUDENT)
  );
  assert.deepEqual(data.teacher_student_bindings, bindingsBefore);
});

test("the renamed name is global: every teacher overview shows the new full_name", async () => {
  const data = tables();
  const db = createMockSupabase(data);
  await renameStudentProfile(db, { studentId: STUDENT, fullName: "张小明" });

  const profile = data.profiles.find((row) => row.id === STUDENT);
  const overview = buildTeacherStudentOverview({
    students: [
      {
        studentId: STUDENT,
        studentDisplayName: getPreferredUserDisplayName({
          email: profile.email,
          profileFullName: profile.full_name
        }),
        studentEmail: profile.email,
        domains: ["reading"]
      },
      {
        studentId: STUDENT,
        studentDisplayName: getPreferredUserDisplayName({
          email: profile.email,
          profileFullName: profile.full_name
        }),
        studentEmail: profile.email,
        domains: ["writing"]
      }
    ],
    practiceRows: []
  });

  assert.deepEqual(overview.map((entry) => entry.studentDisplayName), ["张小明", "张小明"]);
});

test("inactive students, non-students, and unknown ids can never be renamed", async () => {
  const data = tables();
  const db = createMockSupabase(data);

  assert.equal(await renameStudentProfile(db, { studentId: "student-inactive", fullName: "无" }), null);
  assert.equal(await renameStudentProfile(db, { studentId: TEACHER_READING, fullName: "无" }), null);
  assert.equal(await renameStudentProfile(db, { studentId: "missing", fullName: "无" }), null);
  assert.equal(data.profiles.find((row) => row.id === "student-inactive").full_name, "停用学生");
  assert.equal(data.profiles.find((row) => row.id === TEACHER_READING).full_name, "阅读老师");
});

test("blank and whitespace-only names are rejected before any write", () => {
  for (const value of ["", "   ", "\n\t", null, undefined, 42, {}]) {
    const result = validateStudentFullName(value);
    assert.equal(result.ok, false);
    assert.equal(result.error, "学生姓名不能为空。");
  }

  assert.deepEqual(validateStudentFullName("  张 小明 "), { ok: true, fullName: "张 小明" });
  assert.equal(normalizeStudentFullName(" 张  小明 "), "张 小明");
  assert.equal(
    validateStudentFullName("名".repeat(MAX_STUDENT_FULL_NAME_LENGTH + 1)).ok,
    false
  );
});

test("teacher rename API re-checks bindings server-side and trusts no client teacherId", () => {
  const route = read("app/api/teacher/students/[studentId]/route.ts");

  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /requireTeacherOnly\(bearerToken\(request\)\)/);
  assert.match(route, /canManageStudent\(/);
  assert.match(route, /status: 403/);
  assert.match(route, /validateStudentFullName\(body\.fullName\)/);
  assert.match(route, /renameStudentProfile\(/);
  assert.match(route, /Cache-Control[\s\S]{0,30}"no-store"/);
  // Authorization can never be chosen by the client.
  assert.doesNotMatch(route, /body\.teacherId/);
  assert.doesNotMatch(route, /owner_id/);
  assert.doesNotMatch(route, /student_account_limit|createUser|deleteUser|teacher_student_bindings"\)[\s\S]{0,160}\.(insert|delete|update)\(/);
});

test("admin rename API is admin-only and scoped to active students", () => {
  const route = read("app/api/admin/students/[studentId]/route.ts");

  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /requireAdmin\(bearerToken\(request\)\)/);
  assert.doesNotMatch(route, /requireTeacherOnly/);
  assert.match(route, /status: 403/);
  assert.match(route, /validateStudentFullName\(body\.fullName\)/);
  assert.match(route, /renameStudentProfile\(/);
  assert.doesNotMatch(route, /owner_id|student_account_limit/);
});

test("renamed students re-sort, re-group, and re-index by the new surname letter", () => {
  const before = createStudentSearchMetadata("陈小明");
  const after = createStudentSearchMetadata("张小明");
  assert.equal(before.group, "C");
  assert.equal(after.group, "Z");
  assert.ok(compareStudentSearchGroups(before.group, after.group) < 0);
  assert.ok(
    compareStudentSearchMetadata(
      { ...before, displayName: "陈小明", id: "s-1" },
      { ...after, displayName: "张小明", id: "s-1" }
    ) < 0
  );

  // Search metadata follows the new name, not the old one.
  assert.equal(studentSearchRank(after, "张小明", "张小明"), 0);
  assert.equal(studentSearchRank(after, "张小明", "zhang"), 3);
  assert.equal(studentSearchRank(before, "陈小明", "zhang"), Number.POSITIVE_INFINITY);
});

test("teacher student list uses the shared inline editor and regenerates overview metadata", () => {
  const list = read("components/teacher/TeacherStudentOverview.tsx");

  assert.match(list, /import \{ InlineStudentNameEditor \} from "@\/components\/shared\/InlineStudentNameEditor"/);
  assert.match(list, /PATCH", body: JSON.stringify\(\{ fullName \}\)/);
  assert.match(list, /cache\.invalidate\(TEACHER_STUDENT_OVERVIEW_CACHE_KEY\)/);
  assert.match(list, /publishCacheInvalidation\(\{ type: "TEACHER_BINDING_UPDATED" \}\)/);
  // Sorting/groups/letter index always derive from freshly fetched names.
  assert.match(list, /createStudentSearchEntry/);
  assert.match(list, /createStudentSearchMetadata\(displayName\)/);
});

test("admin student list reuses the same inline editor against the admin endpoint", () => {
  const admin = read("components/admin/AdminStudents.tsx");

  assert.match(admin, /import \{ InlineStudentNameEditor \} from "@\/components\/shared\/InlineStudentNameEditor"/);
  assert.match(admin, /\/api\/admin\/students\/\$\{encodeURIComponent\(studentId\)\}/);
  assert.match(admin, /publishCacheInvalidation/);
  assert.match(admin, /await load\(\)/);
  // The pencil/input UI lives only in the shared editor, never duplicated.
  assert.doesNotMatch(admin, /<Pencil|aria-label="学生姓名"/);
});

test("account context exposes the profile display name from /api/account/me", () => {
  const auth = read("lib/auth.ts");
  assert.match(auth, /select\("role,is_active,full_name,email"\)/);
  assert.match(auth, /getPreferredUserDisplayName/);
  assert.match(auth, /displayName: string \| null/);

  const accountApi = read("app/api/account/me/route.ts");
  assert.match(accountApi, /displayName: account\.displayName \?\? ""/);

  const gate = read("components/RoleGate.tsx");
  assert.match(gate, /displayName: string/);
  assert.match(gate, /payload\.displayName\?\.trim\(\) \|\| payload\.userId/);
});

test("Student, Teacher, and Admin headers show the profile name instead of the login account", () => {
  const teacherShell = read("components/teacher/TeacherAppShell.tsx");
  assert.match(teacherShell, /const \{ displayName, role \} = useCurrentAccount\(\)/);
  assert.match(teacherShell, /\{displayName\}/);
  assert.doesNotMatch(teacherShell, /formatAccountForDisplay|loadTeacherEmail|teacher:current-user-email|supabase\.auth\.getUser/);

  const studentShell = read("components/student/StudentShell.tsx");
  assert.match(studentShell, /const \{ displayName, role \} = useCurrentAccount\(\)/);
  assert.match(studentShell, /\{displayName\}/);
  assert.doesNotMatch(studentShell, /formatAccountForDisplay/);

  // Admin shares the same TeacherAppShell and therefore the same identity source.
  assert.match(read("app/teacher/students/page.tsx"), /TeacherAppShell/);

  const signOut = read("components/SignOutButton.tsx");
  assert.doesNotMatch(
    signOut,
    /formatAccountForDisplay|getPreferredUserDisplayName|showIdentity|user_metadata|supabase\.auth\.getUser/
  );
});

test("legacy accounts without a valid full_name still get a non-empty header name", () => {
  assert.equal(getPreferredUserDisplayName({ email: "zengyan@bas.com", profileFullName: null }), "zengyan");
  assert.equal(getPreferredUserDisplayName({ email: "zengyan@bas.com", profileFullName: "   " }), "zengyan");
  assert.equal(getPreferredUserDisplayName({ email: "legacy@example.com", profileFullName: null }), "legacy@example.com");
  assert.equal(getPreferredUserDisplayName({ email: "zengyan@bas.com", profileFullName: "曾焱" }), "曾焱");
  // A full_name equal to the login account is not a display name.
  assert.equal(getPreferredUserDisplayName({ email: "zengyan@bas.com", profileFullName: "zengyan@bas.com" }), "zengyan");
  assert.equal(getPreferredUserDisplayName({ email: null, profileFullName: null }), "Unknown user");
});

test("Phase 7 binding, quota, and account ownership flows are not regressed", () => {
  const createRoute = read("app/api/teacher/students/route.ts");
  assert.match(createRoute, /owner_id: auth\.userId/);
  assert.match(createRoute, /STUDENT_ACCOUNT_LIMIT_REACHED/);
  assert.match(createRoute, /createTeacherStudentBindings/);

  const bindRoute = read("app/api/teacher/student-bindings/route.ts");
  assert.match(bindRoute, /teacherId: auth\.userId/);
  assert.doesNotMatch(bindRoute, /body\.teacherId/);

  // Rename never mutates bindings or assignment/attempt history.
  const renameRoute = read("app/api/teacher/students/[studentId]/route.ts");
  assert.doesNotMatch(
    renameRoute,
    /\.from\("(?:teacher_student_bindings|writing_assignments|writing_attempts|reading_attempts|attempts)"\)/
  );
});
