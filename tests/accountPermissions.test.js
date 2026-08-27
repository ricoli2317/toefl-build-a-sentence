import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canAssignRecipient } from "../lib/accountAccess.ts";
import { defaultRouteForRole, roleCanAccess } from "../lib/accountPermissions.ts";

test("role capabilities allow Admin in both areas without widening Teacher or Student", () => {
  assert.equal(roleCanAccess("admin", "teacher"), true);
  assert.equal(roleCanAccess("admin", "student"), true);
  assert.equal(roleCanAccess("teacher", "teacher"), true);
  assert.equal(roleCanAccess("teacher", "student"), false);
  assert.equal(roleCanAccess("student", "student"), true);
  assert.equal(roleCanAccess("student", "teacher"), false);
  assert.equal(defaultRouteForRole("admin"), "/teacher/dashboard");
  assert.equal(defaultRouteForRole("teacher"), "/teacher/dashboard");
  assert.equal(defaultRouteForRole("student"), "/student");
});

test("only Admin can self-assign; Teacher remains limited to owned students", () => {
  const admin = { userId: "admin-1", role: "admin" };
  const teacher = { userId: "teacher-1", role: "teacher" };
  assert.equal(canAssignRecipient(admin, { id: "admin-1", role: "admin", ownerId: null, isActive: true }), true);
  assert.equal(canAssignRecipient(teacher, { id: "teacher-1", role: "teacher", ownerId: null, isActive: true }), false);
  assert.equal(canAssignRecipient(teacher, { id: "student-1", role: "student", ownerId: "teacher-1", isActive: true }), true);
  assert.equal(canAssignRecipient(teacher, { id: "student-2", role: "student", ownerId: "teacher-2", isActive: true }), false);
  assert.equal(canAssignRecipient(teacher, { id: "admin-1", role: "admin", ownerId: null, isActive: true }), false);
});

test("login is unified and resolves role through the protected account endpoint", async () => {
  const source = await readFile(new URL("../components/LoginPanel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /setRole|aria-pressed|\["student", "teacher"\]/);
  assert.match(source, /\/api\/account\/me/);
  assert.match(source, /resolveAuthenticatedRoute/);
});

test("schema enforces ownership quota and Admin self-assignment without ownership", async () => {
  const roles = await readFile(new URL("../supabase/account_roles_and_ownership.sql", import.meta.url), "utf8");
  const selfAssignment = await readFile(new URL("../supabase/admin_self_assignment.sql", import.meta.url), "utf8");
  assert.match(roles, /STUDENT_ACCOUNT_LIMIT_REACHED/);
  assert.match(roles, /actor\.role = 'admin'.*recipient\.id = actor\.id/s);
  assert.match(selfAssignment, /can_assign_student_as\(p_teacher_id, students\.id\)/);
  assert.doesNotMatch(selfAssignment, /insert into public\.profiles/);
});

test("merge keeps final Admin student UID in place and migrates every nonzero Teacher reference", async () => {
  const sql = await readFile(new URL("../supabase/admin_test_account_merge.sql", import.meta.url), "utf8");
  assert.match(sql, /final_admin_id constant uuid := '6f333422-384a-44fb-8a83-e9c1aadb0caf'/);
  assert.match(sql, /retired_teacher_id constant uuid := 'b5ac07d0-94cf-4553-86a8-64f8b9ad23da'/);
  assert.match(sql, /update public\.writing_assignments[\s\S]*teacher_id = final_admin_id/);
  assert.match(sql, /update public\.writing_assignment_groups[\s\S]*teacher_id = final_admin_id/);
  assert.match(sql, /update public\.question_sets[\s\S]*created_by = final_admin_id/);
  assert.doesNotMatch(sql, /delete\s+from\s+(auth\.users|public\.profiles)/i);
});
