import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  STUDENT_BINDING_DOMAINS,
  emptyBindingDomain,
  normalizeBindingDomains
} from "../lib/studentBindings.ts";
import { removeTeacherStudentBinding } from "../lib/teacherStudentBindings.ts";
import { createMockSupabase } from "./fixtures/mockSupabase.js";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

function bindingsFor(data, teacherId, studentId) {
  return (data.teacher_student_bindings ?? [])
    .filter((row) => row.teacher_id === teacherId && row.student_id === studentId)
    .map((row) => row.domain)
    .sort();
}

function tables() {
  return {
    teacher_student_bindings: [
      { binding_id: "b-1r", teacher_id: "teacher-a", student_id: "student-1", domain: "reading" },
      { binding_id: "b-1w", teacher_id: "teacher-a", student_id: "student-1", domain: "writing" },
      { binding_id: "b-2w", teacher_id: "teacher-b", student_id: "student-1", domain: "writing" }
    ]
  };
}

test("the empty dashed badge targets the single missing subject, always on the right", () => {
  // [阅读] + 空 badge -> 新增 Writing; [写作] + 空 badge -> 新增 Reading.
  assert.equal(emptyBindingDomain(["reading"]), "writing");
  assert.equal(emptyBindingDomain(["writing"]), "reading");
  assert.equal(emptyBindingDomain(["writing", "reading"]), null);
  assert.equal(emptyBindingDomain(["reading", "writing"]), null);
  assert.equal(emptyBindingDomain([]), null);
  assert.equal(emptyBindingDomain(["writing", "math"]), "reading");
  // Canonical order is fixed no matter which subject was created first.
  assert.deepEqual(normalizeBindingDomains(["writing", "reading"]), ["reading", "writing"]);
  assert.deepEqual(STUDENT_BINDING_DOMAINS, ["reading", "writing"]);
});

test("removing a subject deletes exactly one current-teacher binding", async () => {
  const data = tables();
  const db = createMockSupabase(data);

  const removed = await removeTeacherStudentBinding(db, {
    teacherId: "teacher-a",
    studentId: "student-1",
    domain: "writing"
  });
  assert.deepEqual(removed, { ok: true, removed: true });
  assert.deepEqual(bindingsFor(data, "teacher-a", "student-1"), ["reading"]);
  // Teacher B keeps the same student's Writing binding.
  assert.deepEqual(bindingsFor(data, "teacher-b", "student-1"), ["writing"]);

  // Removing a subject the teacher does not hold changes nothing.
  const missing = await removeTeacherStudentBinding(db, {
    teacherId: "teacher-a",
    studentId: "student-1",
    domain: "writing"
  });
  assert.deepEqual(missing, { ok: true, removed: false });
  assert.deepEqual(bindingsFor(data, "teacher-b", "student-1"), ["writing"]);
});

test("student binding delete API is teacher-scoped and never takes a teacher id from the client", async () => {
  const route = await read("app/api/teacher/student-bindings/route.ts");
  assert.match(route, /export async function DELETE/);
  assert.match(route, /requireTeacherOnly\(bearerToken\(request\)\)/);
  assert.match(route, /isStudentBindingDomain\(domain\)/);
  assert.match(route, /removeTeacherStudentBinding\(createServiceSupabase\(\), \{/);
  assert.match(route, /teacherId: auth\.userId/);
  assert.doesNotMatch(route, /body\.teacherId/);
  assert.doesNotMatch(route, /teacherId:\s*body/);
  // Deleting never touches class subjects or memberships.
  assert.doesNotMatch(route, /teacher_classes|class_members/);
});

test("both per-student entry points use the same binding API and shared badge UI", async () => {
  const list = await read("components/teacher/TeacherStudentOverview.tsx");
  const detail = await read("components/teacher/TeacherStudentPracticeSection.tsx");
  const client = await read("lib/teacherStudentBindingClient.ts");

  for (const source of [list, detail]) {
    assert.match(source, /addStudentBindingDomains/);
    assert.match(source, /removeStudentBindingDomain/);
  }
  assert.match(client, /\/api\/teacher\/student-bindings/);
  assert.match(client, /method: "DELETE"/);

  // Student list column is 授课科目 with the shared quick-edit badges.
  assert.match(list, /授课科目/);
  assert.match(list, /SubjectBindingBadges/);
  assert.doesNotMatch(list, /<th className="px-3 py-3 font-medium">学科<\/th>/);

  // Student detail keeps the class-detail modal look and stacks双科目 vertically.
  assert.match(detail, /修改授课科目/);
  assert.match(detail, /TeacherSubjectFieldset/);
  assert.match(detail, /SubjectBadgeStack direction="column"/);
  assert.match(detail, /ModalShell/);

  const badges = await read("components/teacher/SubjectBadges.tsx");
  assert.match(badges, /emptyBindingDomain/);
  assert.match(badges, /STUDENT_BINDING_DOMAIN_LABELS/);
  assert.match(badges, /是否新增/);
  assert.match(badges, /是否不再负责/);
  assert.match(badges, /border-dashed/);
  assert.match(badges, /-right-1 -top-1.5/);
});

test("home class list quick badges edit the class subject set only", async () => {
  const classList = await read("components/teacher/TeacherClassList.tsx");
  assert.match(classList, /SubjectBindingBadges/);
  assert.match(classList, /updateTeacherClassSubjectsRequest/);
  assert.match(classList, /applyClassSubjectsMutation/);
  assert.match(classList, /班级至少保留一个授课科目/);
  assert.doesNotMatch(classList, /removeTeacherStudentBinding|student-bindings/);

  const detail = await read("components/teacher/TeacherClassDetail.tsx");
  assert.match(detail, /修改授课科目/);
  assert.match(detail, /TeacherSubjectFieldset/);
  assert.match(detail, /updateTeacherClassSubjectsRequest/);
  assert.match(detail, /\/members\//);
  // Direct membership removal, no writing-decision prompt.
  assert.match(detail, /onClick=\{\(\) => void removeMember\(member\)\}/);
  assert.doesNotMatch(detail, /是否继续接收/);
  assert.doesNotMatch(detail, /writingDecision/);
});

test("losing the last binding never leaves a cached student view readable", async () => {
  const cache = await read("components/TeacherDataCache.tsx");
  assert.match(cache, /TEACHER_STUDENT_BAS_SET_CACHE_PREFIX = "teacher:student-bas-set:v1"/);
  assert.match(cache, /TEACHER_STUDENT_BAS_ANSWER_CACHE_PREFIX = "teacher:student-bas-answer:v1"/);
  assert.match(cache, /event\.type === "TEACHER_BINDING_UPDATED" && event\.studentId/);
  assert.match(cache, /TEACHER_STUDENT_BAS_SET_CACHE_PREFIX\}:\$\{event\.studentId\}/);
  assert.match(cache, /TEACHER_STUDENT_BAS_ANSWER_CACHE_PREFIX\}:\$\{event\.studentId\}/);

  const list = await read("components/teacher/TeacherStudentOverview.tsx");
  assert.match(list, /publishCacheInvalidation\(\{ type: "TEACHER_BINDING_UPDATED", studentId \}\)/);
  const detail = await read("components/teacher/TeacherStudentPracticeSection.tsx");
  assert.match(detail, /publishCacheInvalidation\(\{ type: "TEACHER_BINDING_UPDATED", studentId \}\)/);
  // The detail page turns both the local "no subject left" state and the 403
  // of a fresh load into the explicit no-access card; practice data is never
  // rendered from cache in that state.
  assert.match(detail, /StudentAccessRemovedCard/);
  assert.match(detail, /practiceAccessLost\(state\.error\)/);
  assert.match(detail, /未找到该学生\|无权查看\|forbidden/);
  assert.match(detail, /if \(noDomains\) \{[\s\S]{0,1200}StudentAccessRemovedCard/);
  assert.doesNotMatch(detail, /if \(noDomains\) \{[\s\S]{0,400\}payload\.reading/);
});

test("new classes and added members gain the bindings the class subjects require", async () => {  const server = await read("lib/teacherClasses.server.ts");
  const sql = await read("supabase/teacher_classes.sql");

  // New class: accounts are created with the class subjects and every member
  // is synced through the class-subject binding backfill.
  assert.match(server, /createNewClassMembers\(db, teacherId, input\.subjects/);
  assert.match(server, /syncClassMembers\(db, teacherId, classId, memberIds\)/);
  assert.match(server, /subjects = normalizeClassSubjects\(classRow\.subjects\)/);

  const syncRpc = sql.match(/create or replace function public\.sync_class_members[\s\S]*?\n\$\$;/)?.[0] ?? "";
  assert.match(
    syncRpc,
    /insert into public\.teacher_student_bindings \(teacher_id, student_id, domain\)[\s\S]{0,240}cross join unnest\(class_subjects\)/
  );
  assert.match(syncRpc, /on conflict \(teacher_id, student_id, domain\) do nothing/);

  // Adding a class subject backfills the missing member bindings.
  const updateRpc = sql.match(/create or replace function public\.update_class_subjects[\s\S]*?\n\$\$;/)?.[0] ?? "";
  assert.match(updateRpc, /cross join unnest\(p_subjects\)/);
  assert.match(updateRpc, /on conflict \(teacher_id, student_id, domain\) do nothing/);
});
