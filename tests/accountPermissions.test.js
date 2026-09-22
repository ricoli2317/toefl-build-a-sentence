import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canAssignRecipient } from "../lib/accountAccess.ts";
import { defaultRouteForRole, roleCanAccess } from "../lib/accountPermissions.ts";
import { createMockSupabase } from "./fixtures/mockSupabase.js";

test("role capabilities allow Admin and Teacher in both areas without widening Student", () => {
  assert.equal(roleCanAccess("admin", "teacher"), true);
  assert.equal(roleCanAccess("admin", "student"), true);
  assert.equal(roleCanAccess("teacher", "teacher"), true);
  assert.equal(roleCanAccess("teacher", "student"), true);
  assert.equal(roleCanAccess("student", "student"), true);
  assert.equal(roleCanAccess("student", "teacher"), false);
  assert.equal(defaultRouteForRole("admin"), "/teacher/dashboard");
  assert.equal(defaultRouteForRole("teacher"), "/teacher/dashboard");
  assert.equal(defaultRouteForRole("student"), "/student");
});

test("only Admin can self-assign; Teacher assigns through a writing-domain binding", async () => {
  const admin = { userId: "admin-1", role: "admin" };
  const teacher = { userId: "teacher-1", role: "teacher" };
  const supabase = createMockSupabase({
    teacher_student_bindings: [
      { binding_id: "b-w", teacher_id: "teacher-1", student_id: "student-1", domain: "writing" },
      { binding_id: "b-r", teacher_id: "teacher-1", student_id: "student-2", domain: "reading" }
    ]
  });
  assert.equal(
    await canAssignRecipient(supabase, admin, { id: "admin-1", role: "admin", isActive: true }),
    true
  );
  assert.equal(
    await canAssignRecipient(supabase, teacher, { id: "teacher-1", role: "teacher", isActive: true }),
    false
  );
  assert.equal(
    await canAssignRecipient(supabase, teacher, { id: "student-1", role: "student", isActive: true }),
    true
  );
  assert.equal(
    await canAssignRecipient(supabase, teacher, { id: "student-2", role: "student", isActive: true }),
    false
  );
  assert.equal(
    await canAssignRecipient(supabase, teacher, { id: "admin-1", role: "admin", isActive: true }),
    false
  );
  assert.equal(
    await canAssignRecipient(supabase, teacher, { id: "student-1", role: "student", isActive: false }),
    false
  );
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
