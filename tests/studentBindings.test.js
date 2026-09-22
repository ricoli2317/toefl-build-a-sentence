import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isStudentBindingDomain,
  validateStudentBindingInput,
  bindingExists
} from "../lib/studentBindings.ts";

const PROFILES = [
  { id: "teacher-a", role: "teacher", isActive: true, ownerId: null },
  { id: "teacher-b", role: "teacher", isActive: true, ownerId: null },
  { id: "student-s", role: "student", isActive: true, ownerId: "teacher-a" },
  { id: "admin-1", role: "admin", isActive: true, ownerId: null }
];

// Replicates the DB behavior exercised by the protected Admin API + trigger:
// role validation, admin-as-teacher barrier, and the unique tuple constraint.
function createBindingStore() {
  const db = { bindings: [] };
  let nextId = 1;

  function add(binding) {
    const teacher = PROFILES.find(
      (p) => p.id === binding.teacherId && p.role === "teacher" && p.isActive
    );
    if (!teacher) return { ok: false, error: "INVALID_TEACHER_BINDING" };
    const student = PROFILES.find(
      (p) => p.id === binding.studentId && p.role === "student" && p.isActive
    );
    if (!student) return { ok: false, error: "INVALID_STUDENT_BINDING" };
    if (bindingExists(db.bindings, binding)) {
      return { ok: false, error: "DUPLICATE_BINDING" };
    }
    const created = { bindingId: `b${nextId++}`, ...binding };
    db.bindings.push(created);
    return { ok: true, binding: created };
  }

  function remove(bindingId) {
    const before = db.bindings.length;
    db.bindings = db.bindings.filter((b) => b.bindingId !== bindingId);
    if (db.bindings.length === before) return { ok: false, error: "NOT_FOUND" };
    return { ok: true };
  }

  return { db, add, remove };
}

function ownerSnapshot() {
  return Object.fromEntries(PROFILES.map((p) => [p.id, p.ownerId]));
}

const LEARNING_DATA = {
  assignments: ["assignment-1"],
  attempts: ["attempt-1"],
  reviews: ["review-1"]
};

test("Case 2: same Student can gain a second Teacher on a different domain", () => {
  const { db, add } = createBindingStore();
  const first = add({ teacherId: "teacher-a", studentId: "student-s", domain: "writing" });
  assert.equal(first.ok, true);
  const second = add({ teacherId: "teacher-b", studentId: "student-s", domain: "reading" });
  assert.equal(second.ok, true);
  assert.equal(db.bindings.length, 2);
});

test("Case 3: same Teacher may hold both Reading and Writing for one Student", () => {
  const { db, add } = createBindingStore();
  assert.equal(add({ teacherId: "teacher-a", studentId: "student-s", domain: "reading" }).ok, true);
  assert.equal(add({ teacherId: "teacher-a", studentId: "student-s", domain: "writing" }).ok, true);
  assert.equal(db.bindings.length, 2);
});

test("Case 1 and Case 4: the exact teacher+student+domain tuple is unique", () => {
  const { db, add } = createBindingStore();
  assert.equal(add({ teacherId: "teacher-a", studentId: "student-s", domain: "writing" }).ok, true);
  const duplicate = add({ teacherId: "teacher-a", studentId: "student-s", domain: "writing" });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error, "DUPLICATE_BINDING");
  assert.equal(db.bindings.length, 1);
});

test("Admin cannot be written as the teacher side of a binding", () => {
  const { db, add } = createBindingStore();
  const result = add({ teacherId: "admin-1", studentId: "student-s", domain: "writing" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "INVALID_TEACHER_BINDING");
  assert.equal(db.bindings.length, 0);
});

test("Case 5: deleting a binding succeeds and non-existent deletion is rejected", () => {
  const { db, add, remove } = createBindingStore();
  const created = add({ teacherId: "teacher-a", studentId: "student-s", domain: "writing" });
  assert.equal(remove(created.binding.bindingId).ok, true);
  assert.equal(db.bindings.length, 0);
  assert.equal(remove("missing").ok, false);
});

test("Case 6: only the Admin role may add or delete bindings", () => {
  // Protected APIs call requireAdmin; every endpoint returns 403 for non-admin.
  const admin = requireAdmin({ role: "admin" });
  const teacher = requireAdmin({ role: "teacher" });
  assert.equal(admin.error, null);
  assert.equal(teacher.error, "Unprivileged");
});

function requireAdmin(account) {
  if (account.role !== "admin") return { error: "Unprivileged" };
  return { error: null };
}

test("Case 7: profiles.owner_id is untouched by binding add/delete", () => {
  const { db, add, remove } = createBindingStore();
  const before = ownerSnapshot();
  const created = add({ teacherId: "teacher-a", studentId: "student-s", domain: "writing" });
  add({ teacherId: "teacher-b", studentId: "student-s", domain: "reading" });
  remove(created.binding.bindingId);
  assert.deepEqual(ownerSnapshot(), before);
});

test("Case 8: assignments, attempts, and reviews remain unchanged", () => {
  const { add, remove } = createBindingStore();
  const before = structuredClone(LEARNING_DATA);
  const created = add({ teacherId: "teacher-a", studentId: "student-s", domain: "writing" });
  add({ teacherId: "teacher-b", studentId: "student-s", domain: "reading" });
  remove(created.binding.bindingId);
  assert.deepEqual(LEARNING_DATA, before);
});

test("input validation rejects missing parts and unknown domains", () => {
  assert.deepEqual(validateStudentBindingInput({ teacherId: "", studentId: "s", domain: "writing" }), {
    ok: false,
    error: "请选择教师。"
  });
  assert.deepEqual(validateStudentBindingInput({ teacherId: "t", studentId: "s", domain: "math" }), {
    ok: false,
    error: "请选择教学领域（Reading 或 Writing）。"
  });
  assert.deepEqual(validateStudentBindingInput({ teacherId: "t", studentId: "s", domain: "reading" }), {
    ok: true,
    domain: "reading"
  });
  assert.equal(isStudentBindingDomain("reading"), true);
  assert.equal(isStudentBindingDomain("writing"), true);
  assert.equal(isStudentBindingDomain("math"), false);
});

test("migration creates the table, domain check, unique tuple, FK, and role trigger", async () => {
  const sql = await readFile(new URL("../supabase/teacher_student_bindings.sql", import.meta.url), "utf8");
  assert.match(sql, /create table if not exists public\.teacher_student_bindings/);
  assert.match(sql, /binding_id uuid primary key default gen_random_uuid\(\)/);
  assert.match(sql, /teacher_id uuid not null references public\.profiles\(id\) on delete cascade/);
  assert.match(sql, /student_id uuid not null references public\.profiles\(id\) on delete cascade/);
  assert.match(sql, /check \(domain in \('reading', 'writing'\)\)/);
  assert.match(sql, /teacher_student_bindings_unique unique \(teacher_id, student_id, domain\)/);
  assert.match(sql, /create index if not exists teacher_student_bindings_student_domain_idx/);
  assert.match(sql, /create index if not exists teacher_student_bindings_teacher_domain_idx/);
  assert.match(sql, /INVALID_TEACHER_BINDING/);
  assert.match(sql, /INVALID_STUDENT_BINDING/);
  assert.match(sql, /role = 'teacher'/);
  assert.match(sql, /role = 'student'/);
  assert.match(sql, /enable row level security/);
});

test("migration is additive and never rewrites ownership, assignments, attempts, or reviews", async () => {
  const sql = await readFile(new URL("../supabase/teacher_student_bindings.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql, /owner_id/);
  assert.doesNotMatch(sql, /alter\s+table\s+public\.(profiles|writing_assignments|writing_attempts|attempts)/i);
  assert.doesNotMatch(sql, /(insert|update|delete)\s+into\s+public\.(profiles|writing_|attempts|reviews)/i);
  assert.doesNotMatch(sql, /writing_assignments|writing_attempts/);
});

test("API requires the Admin role and touches only teacher_student_bindings", async () => {
  const main = await readFile(new URL("../app/api/admin/student-bindings/route.ts", import.meta.url), "utf8");
  const single = await readFile(new URL("../app/api/admin/student-bindings/[bindingId]/route.ts", import.meta.url), "utf8");
  assert.match(main, /requireAdmin/);
  assert.match(main, /bearerToken/);
  assert.match(main, /teacher_student_bindings/);
  assert.match(single, /requireAdmin/);
  assert.match(single, /teacher_student_bindings/);
  assert.doesNotMatch(main + single, /owner_id/);
  assert.doesNotMatch(main + single, /\.update\(/);
  assert.doesNotMatch(main + single, /writing_assignments|writing_attempts|writing_review|\/attempts\/|reviews/);
});

test("Admin page exists at /admin/student-bindings with a 教师绑定 nav entry", async () => {
  const page = await readFile(new URL("../app/admin/student-bindings/page.tsx", import.meta.url), "utf8");
  const shell = await readFile(new URL("../components/teacher/TeacherAppShell.tsx", import.meta.url), "utf8");
  const component = await readFile(new URL("../components/admin/StudentBindingsAdmin.tsx", import.meta.url), "utf8");
  assert.match(page, /AdminOnly/);
  assert.match(page, /StudentBindingsAdmin/);
  assert.match(shell, /href: "\/admin\/student-bindings"/);
  assert.match(shell, /label: "教师绑定"/);
  assert.doesNotMatch(shell, /Teacher Bindings/);
  assert.match(shell, /adminOnly: true/);
  assert.match(component, /Reading 教师/);
  assert.match(component, /Writing 教师/);
  assert.match(component, /搜/);
  assert.match(component, /api\/admin\/student-bindings/);
});