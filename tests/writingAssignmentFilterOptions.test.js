import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(resolve(projectRoot, relativePath), "utf8");

test("assignment student filter reads recipients directly instead of walking groups and assignments", () => {
  const route = read("app/api/teacher/writing/assignments/filter-options/route.ts");
  // The old three-layer history walk (groups -> assignment ids -> recipients)
  // must not remain.
  assert.doesNotMatch(route, /from\("writing_assignment_groups"\)/);
  assert.doesNotMatch(route, /\.in\("group_id", batch\)/);
  assert.doesNotMatch(route, /const assignmentIds = new Set/);
  // Recipient rows are filtered through the existing assignment/group keys.
  assert.match(route, /from\("writing_assignment_students"\)/);
  assert.match(route, /assignment:writing_assignments!inner/);
  assert.match(route, /assignment\.teacher_id", teacherId/);
  assert.match(route, /assignment\.deleted_at", null/);
  assert.match(route, /assignment\.group_id", null/);
  assert.match(route, /assignment\.group\.teacher_id", teacherId/);
  assert.match(route, /assignment\.group\.class_id", null/);
  // Historical recipients are still included; the current binding scope is
  // not used as a substitute.
  assert.doesNotMatch(route, /loadTeacherScope/);
  assert.doesNotMatch(route, /visibleStudentIds/);
  assert.match(route, /student_id/);
  assert.match(route, /readProfiles/);
});
