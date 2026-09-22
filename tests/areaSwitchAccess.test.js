import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canSwitchArea,
  defaultRouteForRole,
  roleCanAccess
} from "../lib/accountPermissions.ts";

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");

const STUDENT_AREA_ROUTES = [
  "../app/api/sets/route.ts",
  "../app/api/sets/[setId]/questions/route.ts",
  "../app/api/wrong-questions/route.ts",
  "../app/api/grammar-practice/route.ts",
  "../app/api/submissions/route.ts",
  "../app/api/practice-history/route.ts",
  "../app/api/attempts/[attemptId]/route.ts"
];

test("case 1-2: Admin and Teacher can move between Teacher and Student areas", () => {
  for (const role of ["admin", "teacher"]) {
    assert.equal(roleCanAccess(role, "teacher"), true, `${role} keeps Teacher area access`);
    assert.equal(roleCanAccess(role, "student"), true, `${role} gets Student area access`);
    assert.equal(canSwitchArea(role), true, `${role} sees the shared area switcher`);
  }
});

test("case 3-5: Teacher defaults to the Teacher area and Student stays Student-only", () => {
  assert.equal(defaultRouteForRole("teacher"), "/teacher/dashboard");
  assert.equal(defaultRouteForRole("admin"), "/teacher/dashboard");
  assert.equal(defaultRouteForRole("student"), "/student");
  assert.equal(roleCanAccess("student", "teacher"), false);
  assert.equal(canSwitchArea("student"), false);
});

test("case 1-5: RoleGate and the single shared switcher reuse roleCanAccess/canSwitchArea", async () => {
  const gate = await read("../components/RoleGate.tsx");
  assert.match(gate, /const allowed = roleCanAccess\(payload\.role, area\)/);
  assert.doesNotMatch(gate, /payload\.role === "admin" \|\| payload\.role === area/);
  assert.match(gate, /export function AreaSwitch/);
  assert.match(gate, /if \(!canSwitchArea\(account\.role\)\) return null/);
  assert.doesNotMatch(gate, /account\.role !== "admin"\) return null/);

  const teacherShell = await read("../components/teacher/TeacherAppShell.tsx");
  assert.match(teacherShell, /<AreaSwitch current="teacher" \/>/);
  const studentShell = await read("../components/student/StudentShell.tsx");
  assert.match(studentShell, /<AreaSwitch current="student" \/>/);

  // Exactly one switcher implementation renders the two switch labels.
  for (const file of ["../components/teacher/TeacherAppShell.tsx", "../components/student/StudentShell.tsx"]) {
    const source = await read(file);
    assert.doesNotMatch(source, /切换到学生端|切换到教师端/, `${file} must not duplicate the switcher`);
  }
  assert.match(gate, /切换到学生端/);
  assert.match(gate, /切换到教师端/);
});

test("case 6-8: Admin-only capability stays Admin-only and Teacher keeps its own management", async () => {
  const auth = await read("../lib/auth.ts");
  assert.match(auth, /export async function requireAdmin/);
  assert.match(auth, /account\.role !== "admin"/);
  assert.match(auth, /export async function requireTeacherOnly/);
  assert.match(auth, /account\.role !== "teacher"/);

  for (const route of [
    "../app/api/admin/students/route.ts",
    "../app/api/admin/student-bindings/route.ts",
    "../app/api/admin/teachers/route.ts",
    "../app/api/teacher/import-questions/route.ts"
  ]) {
    assert.match(await read(route), /requireAdmin/, `${route} must stay Admin-only`);
  }

  const gate = await read("../components/RoleGate.tsx");
  assert.match(gate, /account\.role !== "admin"\) router\.replace\("\/teacher\/students"\)/);
  assert.match(gate, /account\.role === "admin" \? children : null/);
  assert.match(gate, /account\.role !== "teacher"\) router\.replace\("\/teacher\/dashboard"\)/);

  const shell = await read("../components/teacher/TeacherAppShell.tsx");
  assert.match(shell, /if \(role === "admin"\) return !item\.teacherOnly;/);
  assert.match(shell, /return !item\.adminOnly;/);

  const students = await read("../app/api/teacher/students/route.ts");
  assert.match(students, /requireUserWithRole\(bearerToken\(request\), "teacher"\)/);
  const assignments = await read("../lib/writingAssignmentsServer.ts");
  assert.match(assignments, /requireTeacherOnly/);
});

test("case 7: reading RPC actor gates follow the same Admin student mode for Teacher", async () => {
  const rpcFiles = [
    "../supabase/reading_attempts.sql",
    "../supabase/reading_full_set_attempts.sql",
    "../supabase/reading_full_set_loading_pause_hotfix_20260911.sql",
    "../supabase/reading_full_set_preparing_load_lease_20260914.sql",
    "../supabase/reading_full_set_retake_hotfix.sql",
    "../supabase/reading_full_set_wrongbook_corrections.sql",
    "../supabase/reading_wrongbook_corrections.sql"
  ];
  for (const file of rpcFiles) {
    const source = await read(file);
    assert.match(
      source,
      /profile\.role::text in \('student', 'admin', 'teacher'\)/,
      `${file} must admit Teacher through the shared student-mode gate`
    );
    assert.doesNotMatch(
      source,
      /profile\.role::text in \('student', 'admin'\)/,
      `${file} must not keep the old Teacher-excluding gate`
    );
  }
});

test("case 7: Student-area APIs use the shared roleCanAccess student mode", async () => {
  for (const route of STUDENT_AREA_ROUTES) {
    const source = await read(route);
    assert.doesNotMatch(source, /\["student", "admin"\]/, `${route} must not hardcode the Admin array`);
    assert.match(
      source,
      /roleCanAccess\((?:studentProfile|profile)\.role, "student"\)/,
      `${route} must reuse the shared student-area check`
    );
  }

  const writing = await read("../lib/writingServer.ts");
  assert.match(writing, /roleCanAccess\(profile\.role, "student"\)/);

  const reading = await read("../lib/reading/attemptServer.ts");
  assert.match(reading, /requireUserWithRole\(token, "student"\)/);
  const fullSet = await read("../lib/reading/fullSetAttemptServer.ts");
  assert.match(fullSet, /requireUserWithRole\(token, "student"/);

  const accountGate = await read("../app/api/account/me/route.ts");
  assert.match(accountGate, /defaultRoute: defaultRouteForRole\(account\.role\)/);
});
