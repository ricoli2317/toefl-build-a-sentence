import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function enforce({ studentId, ownerId, ownerRole, ownerLimit = 20, ownedCount = 0 }) {
  if (studentId === ownerId) throw new Error("SELF_STUDENT_OWNER_NOT_ALLOWED");
  if (ownerRole !== "teacher" && ownerRole !== "admin") {
    throw new Error("INVALID_STUDENT_OWNER");
  }
  if (ownerRole === "teacher" && ownedCount >= ownerLimit) {
    throw new Error("STUDENT_ACCOUNT_LIMIT_REACHED");
  }
  return { allowed: true, quotaChecked: ownerRole === "teacher" };
}

test("Teacher -> Student is allowed and checks Teacher quota", () => {
  assert.deepEqual(enforce({ studentId: "s1", ownerId: "t1", ownerRole: "teacher", ownerLimit: 2, ownedCount: 1 }), { allowed: true, quotaChecked: true });
});

test("Admin -> Student is allowed without Teacher quota", () => {
  assert.deepEqual(enforce({ studentId: "s1", ownerId: "a1", ownerRole: "admin", ownerLimit: 1, ownedCount: 999 }), { allowed: true, quotaChecked: false });
});

test("Student -> Student is rejected", () => {
  assert.throws(() => enforce({ studentId: "s1", ownerId: "s2", ownerRole: "student" }), /INVALID_STUDENT_OWNER/);
});

test("self owner is rejected", () => {
  assert.throws(() => enforce({ studentId: "s1", ownerId: "s1", ownerRole: "admin" }), /SELF_STUDENT_OWNER_NOT_ALLOWED/);
});

test("Teacher over quota is rejected", () => {
  assert.throws(() => enforce({ studentId: "s1", ownerId: "t1", ownerRole: "teacher", ownerLimit: 2, ownedCount: 2 }), /STUDENT_ACCOUNT_LIMIT_REACHED/);
});

test("repair SQL preserves strict owner roles and promotes Admin before merge backfill", async () => {
  const repair = await readFile(new URL("../supabase/fix_admin_student_owner_merge.sql", import.meta.url), "utf8");
  const merge = await readFile(new URL("../supabase/admin_test_account_merge.sql", import.meta.url), "utf8");
  assert.match(repair, /owner_role not in \('teacher', 'admin'\)/);
  assert.match(repair, /if owner_role = 'teacher'[\s\S]*STUDENT_ACCOUNT_LIMIT_REACHED/);
  assert.match(repair, /SELF_STUDENT_OWNER_NOT_ALLOWED/);
  assert.doesNotMatch(repair, /delete\s+from/i);
  assert.ok(merge.indexOf("set role = 'admin'") < merge.indexOf("set owner_id = final_admin_id"));
});
