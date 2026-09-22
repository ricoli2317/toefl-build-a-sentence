import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  bindingDomainsForTeacher,
  formatBindingDomainList,
  normalizeBindingDomains,
  validateBindingDomains
} from "../lib/studentBindings.ts";
import {
  buildStudentBindingCandidates,
  buildStudentBindingSummaries,
  createTeacherStudentBindings,
  findActiveStudentsByName,
  groupStudentBindingsByTeacher,
  loadStudentBindingSummaries,
  rollbackCreatedStudentAccount,
  searchActiveStudents
} from "../lib/teacherStudentBindings.ts";
import { createMockSupabase } from "./fixtures/mockSupabase.js";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

function tables() {
  return {
    profiles: [
      { id: "teacher-a", role: "teacher", is_active: true, email: "teachera@bas.com", full_name: "栗科", owner_id: null },
      { id: "teacher-b", role: "teacher", is_active: true, email: "teacherb@bas.com", full_name: "曾焱", owner_id: null },
      { id: "admin-1", role: "admin", is_active: true, email: "student@test.com", full_name: "平台管理员", owner_id: null },
      { id: "student-1", role: "student", is_active: true, email: "zhangsan1@bas.com", full_name: "张三", owner_id: "admin-1" },
      { id: "student-2", role: "student", is_active: true, email: "zhangsan2@bas.com", full_name: "张三", owner_id: "teacher-a" },
      { id: "student-3", role: "student", is_active: false, email: "zhangsan3@bas.com", full_name: "张三", owner_id: "teacher-a" },
      { id: "student-4", role: "student", is_active: true, email: "lisi@bas.com", full_name: "李四", owner_id: "teacher-a" }
    ],
    teacher_student_bindings: [
      { binding_id: "b-1r", teacher_id: "teacher-a", student_id: "student-1", domain: "reading" },
      { binding_id: "b-1w", teacher_id: "teacher-a", student_id: "student-1", domain: "writing" },
      { binding_id: "b-2w", teacher_id: "teacher-b", student_id: "student-2", domain: "writing" },
      { binding_id: "b-4r", teacher_id: "teacher-b", student_id: "student-4", domain: "reading" }
    ]
  };
}

function bindingsFor(db, teacherId, studentId) {
  return (db.teacher_student_bindings ?? [])
    .filter((row) => row.teacher_id === teacherId && row.student_id === studentId)
    .map((row) => row.domain)
    .sort();
}

test("subject validation requires at least one of reading/writing and keeps canonical order", () => {
  assert.deepEqual(normalizeBindingDomains(["writing", "reading"]), ["reading", "writing"]);
  assert.deepEqual(normalizeBindingDomains(["writing", "math"]), ["writing"]);
  assert.deepEqual(normalizeBindingDomains(undefined), []);
  assert.deepEqual(validateBindingDomains(["reading"]), { ok: true, domains: ["reading"] });

  for (const value of [undefined, null, [], ["math"], "reading"]) {
    const result = validateBindingDomains(value);
    assert.equal(result.ok, false);
    assert.equal(result.error, "请至少选择一个授课科目。");
  }
  assert.equal(formatBindingDomainList(["writing", "reading"]), "阅读、写作");
});

test("creating a student binding adds exactly the selected subjects for one teacher/student pair", async () => {
  const data = tables();
  const db = createMockSupabase(data);

  const reading = await createTeacherStudentBindings(db, {
    teacherId: "teacher-b",
    studentId: "student-1",
    domains: ["reading"]
  });
  assert.deepEqual(reading, { ok: true, created: ["reading"], alreadyBound: [] });
  assert.deepEqual(bindingsFor(data, "teacher-b", "student-1"), ["reading"]);

  const writing = await createTeacherStudentBindings(db, {
    teacherId: "teacher-b",
    studentId: "student-1",
    domains: ["writing"]
  });
  assert.deepEqual(writing, { ok: true, created: ["writing"], alreadyBound: [] });
  assert.deepEqual(bindingsFor(data, "teacher-b", "student-1"), ["reading", "writing"]);

  const double = await createTeacherStudentBindings(db, {
    teacherId: "teacher-a",
    studentId: "student-4",
    domains: ["reading", "writing"]
  });
  assert.deepEqual(double, { ok: true, created: ["reading", "writing"], alreadyBound: [] });
  assert.deepEqual(bindingsFor(data, "teacher-a", "student-4"), ["reading", "writing"]);
});

test("existing domains are never duplicated and the missing subject can be added", async () => {
  const data = tables();
  const db = createMockSupabase(data);
  const before = data.teacher_student_bindings.length;

  const supplement = await createTeacherStudentBindings(db, {
    teacherId: "teacher-a",
    studentId: "student-1",
    domains: ["reading", "writing"]
  });
  assert.deepEqual(supplement, { ok: true, created: [], alreadyBound: ["reading", "writing"] });
  assert.equal(data.teacher_student_bindings.length, before);

  const mixed = await createTeacherStudentBindings(db, {
    teacherId: "teacher-b",
    studentId: "student-2",
    domains: ["reading", "writing"]
  });
  assert.deepEqual(mixed, { ok: true, created: ["reading"], alreadyBound: ["writing"] });
  assert.deepEqual(bindingsFor(data, "teacher-b", "student-2"), ["reading", "writing"]);
  assert.equal(data.teacher_student_bindings.length, before + 1);
});

test("Teacher B binds a Teacher A student without changing profiles.owner_id", async () => {
  const data = tables();
  const db = createMockSupabase(data);
  const before = data.profiles.map((profile) => ({ ...profile }));

  await createTeacherStudentBindings(db, {
    teacherId: "teacher-b",
    studentId: "student-2",
    domains: ["reading"]
  });

  assert.deepEqual(data.profiles, before);
  assert.equal(data.profiles.find((profile) => profile.id === "student-2").owner_id, "teacher-a");
  assert.deepEqual(bindingsFor(data, "teacher-b", "student-2"), ["reading", "writing"]);
});

test("the server always binds the authenticated teacher, never a client teacher id", async () => {
  const route = await read("app/api/teacher/student-bindings/route.ts");
  assert.match(route, /requireTeacherOnly\(bearerToken\(request\)\)/);
  assert.match(route, /teacherId: auth\.userId/);
  assert.match(route, /createTeacherStudentBindings\(supabase, \{/);
  assert.doesNotMatch(route, /body\.teacherId/);
  assert.doesNotMatch(route, /teacherId:\s*body/);
  assert.match(route, /ALL_DOMAINS_BOUND/);

  const lib = await read("lib/teacherStudentBindings.ts");
  assert.doesNotMatch(lib, /owner_id/);
});

test("binding an existing student never touches quota or account ownership surfaces", async () => {
  const route = await read("app/api/teacher/student-bindings/route.ts");
  assert.doesNotMatch(route, /student_account_limit/);
  assert.doesNotMatch(route, /owner_id/);
  assert.doesNotMatch(route, /createUser|deleteUser/);

  const lib = await read("lib/teacherStudentBindings.ts");
  assert.doesNotMatch(lib, /student_account_limit/);
  assert.doesNotMatch(lib, /createUser/);
});

test("student search is query-driven and only returns active students", async () => {
  const db = createMockSupabase(tables());

  assert.deepEqual(await searchActiveStudents(db, "   "), []);
  assert.deepEqual(await searchActiveStudents(db, ""), []);

  const byName = await searchActiveStudents(db, "张三");
  assert.deepEqual(byName.map((row) => row.id), ["student-1", "student-2"]);
  assert.equal(byName.some((row) => row.id === "student-3"), false);

  const byAccount = await searchActiveStudents(db, "zhangsan");
  assert.deepEqual(byAccount.map((row) => row.id), ["student-1", "student-2"]);

  const limited = await searchActiveStudents(db, "zhangsan", 1);
  assert.equal(limited.length, 1);
});

test("same-name detection finds every active same-name student and ignores inactive accounts", async () => {
  const db = createMockSupabase(tables());
  const sameName = await findActiveStudentsByName(db, "张三");
  assert.deepEqual(sameName.map((row) => row.id).sort(), ["student-1", "student-2"]);
  assert.deepEqual(await findActiveStudentsByName(db, "张三四"), []);
  assert.deepEqual(await findActiveStudentsByName(db, "  "), []);
});

test("current binding teachers and subjects are derived from teacher_student_bindings, not owner_id", async () => {
  const data = tables();
  const db = createMockSupabase(data);

  const summaries = await loadStudentBindingSummaries(db, ["student-1"]);
  const studentOne = summaries.get("student-1");
  assert.equal(studentOne.length, 1);
  assert.equal(studentOne[0].teacherId, "teacher-a");
  assert.equal(studentOne[0].teacherName, "栗科");
  assert.deepEqual(studentOne[0].domains, ["reading", "writing"]);
  // student-1.owner_id is the Admin account and must never surface.
  assert.equal(studentOne.some((summary) => summary.teacherId === "admin-1"), false);

  const candidates = await buildStudentBindingCandidates(db, data.profiles.filter((p) => p.id === "student-1"));
  assert.deepEqual(candidates, [{
    id: "student-1",
    displayName: "张三",
    email: "zhangsan1@bas.com",
    bindings: [{
      teacherId: "teacher-a",
      teacherName: "栗科",
      teacherEmail: "teachera@bas.com",
      domains: ["reading", "writing"]
    }]
  }]);
});

test("an Admin-created student later bound to 栗科 shows 栗科 and the bound subjects", async () => {
  const db = createMockSupabase(tables());
  const candidates = await buildStudentBindingCandidates(
    db,
    tables().profiles.filter((profile) => profile.id === "student-1" && profile.owner_id === "admin-1")
  );
  const text = candidates[0].bindings
    .map((binding) => `${binding.teacherName} · ${formatBindingDomainList(binding.domains)}`)
    .join("\n");
  assert.equal(text, "栗科 · 阅读、写作");
});

test("multiple teachers on one student aggregate per teacher in canonical subject order", () => {
  const summaries = buildStudentBindingSummaries({
    bindings: [
      { studentId: "s-1", teacherId: "teacher-b", domain: "writing" },
      { studentId: "s-1", teacherId: "teacher-a", domain: "reading" },
      { studentId: "s-1", teacherId: "teacher-b", domain: "reading" }
    ],
    teacherProfiles: [
      { id: "teacher-a", email: "teachera@bas.com", full_name: "栗科" },
      { id: "teacher-b", email: "teacherb@bas.com", full_name: "曾焱" }
    ]
  });
  const rows = summaries.get("s-1").map(
    (binding) => `${binding.teacherName} · ${formatBindingDomainList(binding.domains)}`
  );
  assert.deepEqual(rows, ["栗科 · 阅读", "曾焱 · 阅读、写作"]);
  assert.deepEqual(
    groupStudentBindingsByTeacher([
      { teacherId: "teacher-b", domain: "writing" },
      { teacherId: "teacher-b", domain: "reading" },
      { teacherId: "teacher-a", domain: "reading" }
    ]).map((row) => [row.teacherId, row.domains]),
    [["teacher-b", ["reading", "writing"]], ["teacher-a", ["reading"]]]
  );
});

test("bindingDomainsForTeacher only returns the requested teacher/student pair", () => {
  const bindings = [
    { teacherId: "teacher-a", studentId: "student-1", domain: "reading" },
    { teacherId: "teacher-a", studentId: "student-2", domain: "writing" },
    { teacherId: "teacher-b", studentId: "student-1", domain: "writing" }
  ];
  assert.deepEqual(bindingDomainsForTeacher(bindings, "teacher-a", "student-1"), ["reading"]);
  assert.deepEqual(bindingDomainsForTeacher(bindings, "teacher-b", "student-1"), ["writing"]);
  assert.deepEqual(bindingDomainsForTeacher(bindings, "teacher-a", "student-3"), []);
});

test("a failed binding cleans up the new student profile and auth account", async () => {
  const data = tables();
  const db = createMockSupabase(data);
  const deleted = [];
  await db
    .from("teacher_student_bindings")
    .insert({ teacher_id: "teacher-b", student_id: "new-student", domain: "reading" });
  data.profiles.push({
    id: "new-student",
    role: "student",
    is_active: true,
    email: "newstudent@bas.com",
    full_name: "新学生",
    owner_id: "teacher-b"
  });

  await rollbackCreatedStudentAccount(db, {
    userId: "new-student",
    deleteAuthUser: async (userId) => { deleted.push(userId); }
  });

  assert.equal(data.profiles.some((profile) => profile.id === "new-student"), false);
  assert.deepEqual(deleted, ["new-student"]);
});

test("teacher creation route enforces subjects, duplicate-name flow, and cleanup", async () => {
  const route = await read("app/api/teacher/students/route.ts");

  assert.match(route, /const isTeacher = auth\.role === "teacher"/);
  assert.match(route, /validateBindingDomains\(body\.domains\)/);
  assert.match(route, /if \(isTeacher && !body\.confirmDuplicateName\)/);
  assert.match(route, /findActiveStudentsByName\(supabase, studentName\)/);
  assert.match(route, /code: "DUPLICATE_NAME"/);
  assert.match(route, /candidates/);
  assert.match(route, /code: sameName \? "ACCOUNT_EXISTS_SAME_NAME" : "ACCOUNT_EXISTS"/);
  assert.match(route, /该学生账号已存在，请使用“绑定学生”。/);
  assert.match(route, /if \(isTeacher\) \{\s*const bindings = await createTeacherStudentBindings/);
  assert.match(route, /teacherId: auth\.userId/);
  assert.match(route, /rollbackCreatedStudentAccount\(supabase, \{/);
  assert.doesNotMatch(route, /body\.teacherId/);
  // Account ownership and quota behavior stay on profiles.owner_id.
  assert.match(route, /owner_id: auth\.userId/);
  assert.match(route, /STUDENT_ACCOUNT_LIMIT_REACHED/);
  assert.match(route, /requireUserWithRole\(bearerToken\(request\), "teacher"\)/);
});

test("Admin creation flow stays unchanged and never creates a teaching binding", async () => {
  const route = await read("app/api/teacher/students/route.ts");
  assert.match(route, /if \(auth\.role === "admin"\)/);
  assert.match(route, /student_account_limit/);
  // The only binding creation call sits inside the isTeacher branch.
  const bindingCalls = route.match(/createTeacherStudentBindings\(/g) ?? [];
  assert.equal(bindingCalls.length, 1);
  const teacherGuardIndex = route.indexOf("if (isTeacher) {\n      const bindings = await createTeacherStudentBindings");
  assert.ok(teacherGuardIndex > 0, "binding creation must be inside the teacher-only branch");
});

test("student search API requires a teacher session, a query, and never loads the full library", async () => {
  const route = await read("app/api/teacher/students/search/route.ts");
  assert.match(route, /requireTeacherOnly\(bearerToken\(request\)\)/);
  assert.match(route, /if \(!query && !studentId\) return json\(\{ students: \[\] \}\)/);
  assert.match(route, /searchActiveStudents\(supabase, query\)/);
  assert.match(route, /buildStudentBindingCandidates/);
  assert.doesNotMatch(route, /\.eq\("role", "student"\)\.eq\("is_active", true\)[\s\S]{0,40}\.order[\s\S]{0,40}\.range\(0/);
});

test("students page shows 绑定学生 left of 新增学生 for teachers only", async () => {
  const page = await read("app/teacher/students/page.tsx");
  const actions = await read("components/teacher/TeacherStudentHeaderActions.tsx");
  assert.match(page, /TeacherStudentHeaderActions/);
  assert.match(actions, /role === "teacher"/);
  assert.match(actions, /href="\/teacher\/students\/bind"/);
  assert.match(actions, /href="\/teacher\/students\/new"/);
  assert.ok(
    actions.indexOf("绑定学生") < actions.indexOf("新增学生"),
    "绑定学生 must render before 新增学生"
  );
});

test("bind page and component implement bound-domain display and cache invalidation", async () => {
  const page = await read("app/teacher/students/bind/page.tsx");
  const component = await read("components/teacher/TeacherBindStudent.tsx");
  assert.match(page, /TeacherOnly/);
  assert.match(page, /TeacherBindStudent/);
  assert.match(component, /\/api\/teacher\/students\/search/);
  assert.match(component, /\/api\/teacher\/student-bindings/);
  assert.match(component, /✓ \$\{STUDENT_BINDING_DOMAIN_LABELS\[domain\]\}（已绑定）/);
  assert.match(component, /该学生已绑定全部授课科目。/);
  assert.match(component, /publishCacheInvalidation\(\{ type: "TEACHER_BINDING_UPDATED" \}\)/);
  assert.doesNotMatch(component, /owner_id/);
});

test("create-student UI offers bind-existing / continue-new and publishes binding cache invalidation", async () => {
  const component = await read("components/TeacherCreateStudent.tsx");
  assert.match(component, /授课科目/);
  assert.match(component, /至少选择一个授课科目/);
  assert.match(component, /STUDENT_BINDING_DOMAINS/);
  assert.match(component, /code === "DUPLICATE_NAME"/);
  assert.match(component, /绑定已有学生/);
  assert.match(component, /继续新增/);
  assert.match(component, /confirmDuplicateName: true/);
  assert.match(component, /\/teacher\/students\/bind/);
  assert.match(component, /formatBindingDomainList/);
  assert.match(component, /publishCacheInvalidation\(\{ type: "TEACHER_BINDING_UPDATED" \}\)/);
  assert.doesNotMatch(component, /owner_id/);
});

test("historical writing assignment transfer feature is fully removed", async () => {
  const removedFiles = [
    "app/admin/writing-assignment-transfer/page.tsx",
    "app/api/admin/writing-assignment-transfer/route.ts",
    "components/admin/WritingAssignmentTransfer.tsx",
    "lib/writingAssignmentTransfer.ts",
    "supabase/writing_assignment_ownership_transfer.sql",
    "tests/writingAssignmentTransfer.test.js"
  ];
  for (const file of removedFiles) {
    await assert.rejects(read(file), `removed file still exists: ${file}`);
  }

  const [shell, dashboard] = await Promise.all([
    read("components/teacher/TeacherAppShell.tsx"),
    read("components/TeacherDashboard.tsx")
  ]);
  assert.doesNotMatch(shell, /writing-assignment-transfer|历史作业转移/);
  assert.doesNotMatch(dashboard, /writing-assignment-transfer|历史作业转移/);
});

test("Phase 5/6 teaching permissions stay binding-based and untouched", async () => {
  const accountAccess = await read("lib/accountAccess.ts");
  assert.match(accountAccess, /teacher_student_bindings/);
  assert.doesNotMatch(accountAccess, /\.eq\("owner_id",/);
  assert.match(accountAccess, /listTeacherStudentDomainBindings/);

  const bindRoute = await read("app/api/teacher/student-bindings/route.ts");
  assert.doesNotMatch(bindRoute, /profiles"\)[\s\S]{0,80}\.update\(/);

  const route = await read("app/api/teacher/students/route.ts");
  assert.match(route, /owner_id: auth\.userId/);
  assert.doesNotMatch(route, /from\("teacher_student_bindings"\)[\s\S]{0,120}\.eq\("owner_id"/);
});

test("bind page route resolves under /teacher/students/bind without matching the student detail route", async () => {
  const page = await read("app/teacher/students/bind/page.tsx");
  assert.match(page, /title="绑定学生"/);
  assert.match(page, /TeacherOnly/);
  assert.match(page, /normalizeBindingDomains/);
  assert.match(page, /initialStudentId/);
  assert.match(page, /initialQuery/);
});
