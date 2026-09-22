import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canAssignRecipient,
  canAccessStudentDomain,
  canManageStudent,
  canManageWritingAttempt,
  listVisibleStudentIds,
  listVisibleWritingAttemptIds
} from "../lib/accountAccess.ts";
import { createMockSupabase } from "./fixtures/mockSupabase.js";

function asSet(values) {
  return new Set(values);
}

const tables = () => ({
  profiles: [
    { id: "admin-1", role: "admin", is_active: true },
    { id: "teacher-1", role: "teacher", is_active: true },
    { id: "teacher-2", role: "teacher", is_active: true },
    { id: "teacher-3", role: "teacher", is_active: true },
    { id: "teacher-4", role: "teacher", is_active: true },
    { id: "student-1", role: "student", is_active: true, owner_id: "teacher-0" },
    { id: "student-2", role: "student", is_active: true, owner_id: "teacher-1" },
    { id: "student-3", role: "student", is_active: false, owner_id: "teacher-1" },
    { id: "student-4", role: "student", is_active: true, owner_id: "teacher-4" }
  ],
  teacher_student_bindings: [
    { binding_id: "b1r", teacher_id: "teacher-1", student_id: "student-1", domain: "reading" },
    { binding_id: "b2w", teacher_id: "teacher-2", student_id: "student-1", domain: "writing" },
    { binding_id: "b3r", teacher_id: "teacher-3", student_id: "student-1", domain: "reading" },
    { binding_id: "b3w", teacher_id: "teacher-3", student_id: "student-1", domain: "writing" }
  ],
  writing_attempts: [
    { attempt_id: "att-1", user_id: "student-1", assignment_id: null, status: "submitted" },
    { attempt_id: "att-2", user_id: "student-1", assignment_id: "a-1", status: "submitted" },
    { attempt_id: "att-3", user_id: "student-2", assignment_id: null, status: "submitted" },
    { attempt_id: "att-4", user_id: "student-3", assignment_id: null, status: "submitted" },
    { attempt_id: "att-5", user_id: "student-4", assignment_id: null, status: "submitted" }
  ],
  writing_assignments: [{ assignment_id: "a-1", teacher_id: "teacher-1", deleted_at: null }]
});

const admin = { userId: "admin-1", role: "admin" };
const teacher1 = { userId: "teacher-1", role: "teacher" };
const teacher2 = { userId: "teacher-2", role: "teacher" };
const teacher3 = { userId: "teacher-3", role: "teacher" };
const teacher4 = { userId: "teacher-4", role: "teacher" };

test("case1 reading-only teacher sees reading data but no writing self-practice", async () => {
  const db = createMockSupabase(tables());
  assert.deepEqual(await listVisibleStudentIds(db, teacher1, "reading"), ["student-1"]);
  assert.deepEqual(await listVisibleStudentIds(db, teacher1, "writing"), []);
  assert.deepEqual(await listVisibleWritingAttemptIds(db, teacher1), ["att-2"]);
  assert.equal(await canAccessStudentDomain(db, teacher1, "student-1", "reading"), true);
  assert.equal(await canAccessStudentDomain(db, teacher1, "student-1", "writing"), false);
  assert.equal(await canAccessStudentDomain(db, teacher1, "student-2", "reading"), false);
});

test("case2 writing-only teacher sees writing self-practice but no reading data", async () => {
  const db = createMockSupabase(tables());
  assert.deepEqual(await listVisibleStudentIds(db, teacher2, "reading"), []);
  assert.deepEqual(await listVisibleStudentIds(db, teacher2, "writing"), ["student-1"]);
  assert.deepEqual(await listVisibleWritingAttemptIds(db, teacher2), ["att-1"]);
  assert.equal(await canManageWritingAttempt(db, teacher2, "att-1"), true);
  assert.equal(await canManageWritingAttempt(db, teacher2, "att-2"), false);
  assert.equal(await canAccessStudentDomain(db, teacher2, "student-1", "writing"), true);
  assert.equal(await canAccessStudentDomain(db, teacher2, "student-1", "reading"), false);
});

test("case3 both-domain teacher sees reading and writing self-practice", async () => {
  const db = createMockSupabase(tables());
  assert.deepEqual(await listVisibleStudentIds(db, teacher3, "reading"), ["student-1"]);
  assert.deepEqual(await listVisibleStudentIds(db, teacher3, "writing"), ["student-1"]);
  assert.deepEqual(await listVisibleWritingAttemptIds(db, teacher3), ["att-1"]);
  assert.equal(await canManageStudent(db, teacher3, "student-1"), true);
  assert.equal(await canManageStudent(db, teacher3, "student-2"), false);
});

test("case4 both writing teachers review the same self-practice attempt", async () => {
  const db = createMockSupabase(tables());
  assert.deepEqual(await listVisibleWritingAttemptIds(db, teacher2), ["att-1"]);
  assert.deepEqual(await listVisibleWritingAttemptIds(db, teacher3), ["att-1"]);
  assert.equal(await canManageWritingAttempt(db, teacher2, "att-1"), true);
  assert.equal(await canManageWritingAttempt(db, teacher3, "att-1"), true);
});

test("case5 assignment ownership outperforms a writing binding for other teachers", async () => {
  const db = createMockSupabase(tables());
  assert.equal(await canManageWritingAttempt(db, teacher1, "att-2"), true);
  assert.equal(await canManageWritingAttempt(db, teacher2, "att-2"), false);
  assert.equal(await canManageWritingAttempt(db, teacher3, "att-2"), false);
  assert.equal(await canManageWritingAttempt(db, admin, "att-2"), true);
  assert.equal(await canManageWritingAttempt(db, teacher1, "att-1"), false);
});

test("case6 legacy owner_id is never an access fallback", async () => {
  const db = createMockSupabase(tables());
  assert.deepEqual(await listVisibleStudentIds(db, teacher4, "reading"), []);
  assert.deepEqual(await listVisibleStudentIds(db, teacher4, "writing"), []);
  assert.equal(await canManageStudent(db, teacher4, "student-4"), false);
  assert.equal(await canManageWritingAttempt(db, teacher4, "att-5"), false);
  assert.deepEqual(await listVisibleWritingAttemptIds(db, teacher4), []);
});

test("case7 no binding means no assignment recipients", async () => {
  const db = createMockSupabase(tables());
  assert.equal(
    await canAssignRecipient(db, teacher4, { id: "student-4", role: "student", isActive: true }),
    false
  );
  assert.equal(
    await canAssignRecipient(db, teacher4, { id: "student-1", role: "student", isActive: true }),
    false
  );
});

test("case8 admin bypasses bindings and still excludes inactive accounts", async () => {
  const db = createMockSupabase(tables());
  const visible = await listVisibleStudentIds(db, admin);
  assert.deepEqual(asSet(visible), new Set(["admin-1", "student-1", "student-2", "student-4"]));
  assert.deepEqual(
    asSet(await listVisibleWritingAttemptIds(db, admin)),
    new Set(["att-1", "att-2", "att-3", "att-5"])
  );
  assert.equal(await canManageWritingAttempt(db, admin, "att-3"), true);
  assert.equal(await canManageWritingAttempt(db, admin, "att-4"), false);
  assert.equal(
    await canAssignRecipient(db, admin, { id: "student-2", role: "student", isActive: true }),
    true
  );
});

test("bindings-driven caches invalidate the teacher domain keys", async () => {
  const [matrixSource, componentSource, adminSource] = await Promise.all([
    readFile(new URL("../lib/cacheInvalidation.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/TeacherDataCache.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/admin/StudentBindingsAdmin.tsx", import.meta.url), "utf8")
  ]);
  assert.match(matrixSource, /TEACHER_BINDING_UPDATED/);
  assert.match(matrixSource, /teacherReadingStatistics/);
  assert.match(matrixSource, /"teacherStats"/);
  assert.match(matrixSource, /"teacherWritingReviews"/);
  assert.match(matrixSource, /"teacherWritingReviewWorkspace"/);
  assert.match(matrixSource, /"teacherAssignments"/);
  assert.match(componentSource, /case "teacherReadingStatistics"/);
  assert.match(componentSource, /TEACHER_READING_STATS_CACHE_KEY/);
  assert.match(adminSource, /publishCacheInvalidation\(\{ type: "TEACHER_BINDING_UPDATED" \}\)/);
});