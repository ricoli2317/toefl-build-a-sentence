import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classAssignmentTitleBase,
  classCompletionPercent,
  classIncludesWriting,
  classSubjectsLabel,
  computeClassCompletions,
  filterClassSummariesByName,
  filterDirectWritingAssignments,
  filterWritingAssignmentsByClass,
  formatClassCompletion,
  isClassWritingAssignment,
  normalizeClassSubjects,
  parseClassMemberInputs,
  validateClassName,
  writingClassesOnly
} from "../lib/teacherClasses.ts";
import {
  accountAutoSuffixAllowed,
  accountBaseFromStudentName,
  firstAvailableStudentAccount,
  studentAccountCandidates
} from "../lib/studentAccountSuggestion.ts";
import {
  defaultWritingAssignmentTitle,
  nextWritingAssignmentAutoTitle
} from "../lib/writingAssignments.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(resolve(projectRoot, relativePath), "utf8");
const sql = read("supabase/teacher_classes.sql");

function rpcBlock(name, signatureHint = "") {
  const pattern = new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`
  );
  const match = sql.match(pattern);
  assert.ok(match, `${name} must be defined in supabase/teacher_classes.sql${signatureHint}`);
  return match[0];
}

// 1 + 2 + 3: many-to-many membership across classes/teachers with ownership
test("classes and members support many students per class and many classes per student", () => {
  assert.match(sql, /create table if not exists public\.teacher_classes/);
  assert.match(sql, /create table if not exists public\.class_members/);
  assert.match(sql, /primary key \(class_id, student_id\)/);
  // Membership is keyed by class + student only; there is no per-student
  // global uniqueness and no teacher column on the membership row.
  const membership = sql.match(/create table if not exists public\.class_members[\s\S]*?\);/)?.[0] ?? "";
  assert.doesNotMatch(membership, /unique \(student_id\)/);
  assert.doesNotMatch(membership, /teacher_id/);
  // Every class operation is scoped to its owning teacher.
  for (const name of ["sync_class_members", "update_class_subjects", "remove_class_member"]) {
    const rpc = rpcBlock(name);
    assert.match(rpc, /where class_id = p_class_id and teacher_id = p_teacher_id/, `${name} must scope by teacher`);
  }
  const assignRpc = rpcBlock("create_writing_assignment_group");
  assert.match(assignRpc, /where class_id = p_class_id and teacher_id = p_teacher_id/);
});

test("adding members ensures the subject relations the class requires", () => {
  const sync = rpcBlock("sync_class_members");
  assert.match(sync, /select subjects into class_subjects/);
  assert.match(
    sync,
    /insert into public\.teacher_student_bindings \(teacher_id, student_id, domain\)[\s\S]{0,240}cross join unnest\(class_subjects\)/
  );
  assert.match(sync, /on conflict \(teacher_id, student_id, domain\) do nothing/);
  assert.match(
    sync,
    /insert into public\.class_members \(class_id, student_id\)[\s\S]{0,160}on conflict \(class_id, student_id\) do nothing/
  );
});

// 5: pinyin account suggestion, editable, unique suffix
test("student account suggestion derives pinyin and stays editable", () => {
  assert.equal(accountBaseFromStudentName("张三"), "zhangsan");
  assert.equal(accountBaseFromStudentName("李雷"), "lilei");
  assert.equal(accountBaseFromStudentName("欧阳娜娜"), "ouyangnana");
  assert.equal(accountBaseFromStudentName("Alex"), "alex");
  assert.equal(accountBaseFromStudentName("张三abc"), "zhangsanabc");
  assert.equal(accountBaseFromStudentName("   "), "");
  assert.deepEqual(studentAccountCandidates("zhangsan").slice(0, 4), [
    "zhangsan",
    "zhangsan2",
    "zhangsan3",
    "zhangsan4"
  ]);
});

test("auto suffix keeps account candidates unique and respects manual edits", () => {
  assert.equal(
    firstAvailableStudentAccount("zhangsan", (account) => account === "zhangsan"),
    "zhangsan2"
  );
  assert.equal(
    firstAvailableStudentAccount(
      "zhangsan",
      (account) => account === "zhangsan" || account === "zhangsan2"
    ),
    "zhangsan3"
  );
  assert.equal(firstAvailableStudentAccount("", () => false), null);
  // The suffix rule only applies while the account is the untouched suggestion.
  assert.equal(accountAutoSuffixAllowed(false), true);
  assert.equal(accountAutoSuffixAllowed(true), false);
  const form = read("components/teacher/TeacherClassMemberEditor.tsx");
  assert.match(form, /账号（按姓名自动生成，可修改）/);
  assert.match(form, /accountBaseFromStudentName\(studentName\)/);
});

// 6 + 8: exactly one class per assignment, class must include Writing
test("class assignments accept exactly one Writing class", () => {
  const assignRpc = rpcBlock("create_writing_assignment_group");
  assert.match(assignRpc, /p_class_id uuid/);
  assert.match(assignRpc, /if not \('writing' = any\(class_row\.subjects\)\)/);
  assert.match(assignRpc, /raise exception 'CLASS_NOT_WRITING_CLASS'/);
  assert.match(assignRpc, /raise exception 'CLASS_NOT_FOUND'/);
  assert.match(assignRpc, /insert into public\.writing_assignment_groups \(teacher_id, title, class_id\)/);

  const route = read("app/api/teacher/writing/assignments/route.ts");
  assert.match(route, /const classId = typeof body\.classId === "string"/);
  assert.match(route, /p_class_id: classId/);
  assert.match(route, /CLASS_NOT_WRITING_CLASS": "该班级不包含写作科目。/);
  assert.match(route, /loadWritingClassForAssignment/);
  const form = read("components/teacher/TeacherWritingAssignmentForm.tsx");
  assert.match(form, /一次只能选择一个班级/);
  assert.match(form, /writingClasses/);
  assert.equal(classIncludesWriting(["reading"]), false);
  assert.equal(classIncludesWriting(["reading", "writing"]), true);
  assert.deepEqual(writingClassesOnly([{ subjects: ["reading"] }, { subjects: ["writing"] }]), [
    { subjects: ["writing"] }
  ]);
});

// 7: the two Step 4 modes are mutually exclusive
test("student and class selection modes never mix", () => {
  const form = read("components/teacher/TeacherWritingAssignmentForm.tsx");
  assert.match(form, /selectionMode === "class"[\s\S]{0,120}classId: selectedClassId/);
  assert.match(form, /studentIds: selectedStudents/);
  assert.match(form, /if \(next === "class"\) setSelectedStudents\(\[\]\);\s*\n\s*else setSelectedClassId\(""\)/);
  assert.match(form, /chooseSelectionMode\("students"\)/);
  assert.match(form, /chooseSelectionMode\("class"\)/);
  const route = read("app/api/teacher/writing/assignments/route.ts");
  // Class mode ignores client student ids entirely.
  assert.match(route, /p_student_ids: \[\]/);
});

// 9 + 10 + 11: creation-time snapshot, immutable history
test("class assignment recipients are the creation-time member snapshot", () => {
  const assignRpc = rpcBlock("create_writing_assignment_group");
  assert.match(assignRpc, /from public\.class_members member/);
  assert.match(assignRpc, /unnest\(member_ids\) with ordinality/);
  assert.match(assignRpc, /insert into public\.writing_assignment_students \(assignment_id, student_id, sort_order\)/);
  // Recipients are persisted per assignment; nothing joins memberships at read
  // time, so later joins/leaves never rewrite history.
  const server = read("lib/teacherClasses.server.ts");
  assert.match(server, /from\("writing_assignment_students"\)/);
  assert.match(server, /\.in\("assignment_id", batch\)/);
  assert.doesNotMatch(
    server,
    /from\("class_members"\)[\s\S]{0,200}\.in\("assignment_id"/
  );
});

test("removing a member only deletes the membership row", () => {
  const removeRpc = rpcBlock("remove_class_member");
  assert.doesNotMatch(removeRpc, /writing_assignments/);
  assert.doesNotMatch(removeRpc, /writing_attempts/);
  assert.doesNotMatch(removeRpc, /writing_reviews/);
  assert.match(removeRpc, /delete from public\.class_members/);
  // The RPC keeps its legacy optional binding release, but the app always
  // calls it with false, so memberships and bindings are fully independent.
  const server = read("lib/teacherClasses.server.ts");
  const removeCall = server.slice(server.indexOf('db.rpc("remove_class_member"'));
  assert.match(removeCall.slice(0, 320), /p_remove_writing: false/);
});

// 12 + 13 + 14: titles
test("class assignment titles use class name + Shanghai date with (2)(3) sequence", () => {
  // 2026-09-27 00:00 in Asia/Shanghai.
  const assignedAt = new Date("2026-09-26T16:00:00.000Z");
  assert.equal(classAssignmentTitleBase("周六写作班", assignedAt), "周六写作班 2026-09-27");
  assert.equal(
    nextWritingAssignmentAutoTitle("周六写作班 2026-09-27", ["周六写作班 2026-09-27"]),
    "周六写作班 2026-09-27 (2)"
  );
  assert.equal(
    nextWritingAssignmentAutoTitle("周六写作班 2026-09-27", [
      "周六写作班 2026-09-27",
      "周六写作班 2026-09-27 (2)"
    ]),
    "周六写作班 2026-09-27 (3)"
  );
  // Direct student titles keep their existing format.
  assert.equal(
    defaultWritingAssignmentTitle({
      assignedAt,
      firstStudentName: "张三",
      studentCount: 1
    }),
    "张三 2026-09-27"
  );
  assert.equal(
    defaultWritingAssignmentTitle({
      assignedAt,
      firstStudentName: "张三",
      studentCount: 3
    }),
    "张三等 2026-09-27"
  );
  // Historical titles are never rewritten on rename: the group title comes
  // from the persisted value, not from the current class name.
  const route = read("app/api/teacher/writing/assignments/route.ts");
  assert.match(route, /titleIsAutomatic[\s\S]{0,120}classAssignmentTitleBase\(writingClass\.name/);
});

// 15 + 16: completion and reviews only count the class's own assignments
test("class completion only counts the class's own assignment items", () => {
  const items = [
    { assignment_id: "class-a-1", recipient_student_ids: ["student-1", "student-2"] },
    { assignment_id: "class-a-2", recipient_student_ids: ["student-1"] }
  ];
  const submissions = [
    { assignment_id: "class-a-1", student_id: "student-1" },
    // Direct assignment submission of the same student must not count.
    { assignment_id: "direct-1", student_id: "student-1" },
    // Another class must not count either.
    { assignment_id: "class-b-1", student_id: "student-2" }
  ];
  const counts = computeClassCompletions({ items, submissions });
  assert.deepEqual(counts.get("student-1"), { total: 2, completed: 1 });
  assert.deepEqual(counts.get("student-2"), { total: 1, completed: 0 });
  assert.equal(formatClassCompletion(counts.get("student-1")), "1 / 2");
  assert.equal(classCompletionPercent(counts.get("student-1")), 50);
  assert.equal(formatClassCompletion(undefined), "—");
  assert.equal(classCompletionPercent({ total: 0, completed: 0 }), null);

  const server = read("lib/teacherClasses.server.ts");
  assert.match(server, /\.from\("writing_assignment_groups"\)[\s\S]{0,120}\.eq\("class_id", classId\)/);
  assert.match(server, /\.neq\("status", "withdrawn"\)/);
});

test("class lists, filters and reviews never mix classes or direct assignments", () => {
  const assignments = [
    { assignment_id: "direct-1", class_id: null },
    { assignment_id: "class-a-1", class_id: "class-a" },
    { assignment_id: "class-b-1", class_id: "class-b" }
  ];
  assert.deepEqual(
    filterDirectWritingAssignments(assignments).map((entry) => entry.assignment_id),
    ["direct-1"]
  );
  assert.deepEqual(
    filterWritingAssignmentsByClass(assignments, "class-a").map((entry) => entry.assignment_id),
    ["class-a-1"]
  );
  assert.equal(isClassWritingAssignment({ class_id: "class-a" }), true);
  assert.equal(isClassWritingAssignment({ class_id: null }), false);

  const reviewsRoute = read("app/api/teacher/writing/reviews/route.ts");
  assert.match(reviewsRoute, /listClassAssignmentIds\(supabase, auth\.userId, requestedClassId\)/);
  assert.match(reviewsRoute, /classAssignmentIds !== null/);
  assert.match(reviewsRoute, /scopeIsEmpty/);
  const reviewClassesRoute = read("app/api/teacher/writing/review-classes/route.ts");
  assert.match(reviewClassesRoute, /listClassReviewSummaries/);
  const server = read("lib/teacherClasses.server.ts");
  assert.match(server, /groupToClass\.get\(String\(row\.group_id\)\)/);
});

// 18 + 19 + 20: frozen binding rules, teacher isolation, no Writing prompts
test("class subject and membership changes never release a member binding", () => {
  // Removing a class subject only updates the class row plus the missing
  // bindings for the remaining subjects; existing bindings stay untouched.
  const server = read("lib/teacherClasses.server.ts");
  const updateCall = server.slice(server.indexOf('db.rpc("update_class_subjects"'));
  assert.match(updateCall.slice(0, 320), /p_remove_writing: false/);
  const releaseCalls = server.match(/p_remove_writing: false/g) ?? [];
  assert.equal(releaseCalls.length, 2);
  assert.doesNotMatch(server, /removeWriting/);
  assert.doesNotMatch(server, /writingDecision/);

  // The old 是否继续接收写作作业 decision is gone from both API routes.
  const subjectsRoute = read("app/api/teacher/classes/[classId]/route.ts");
  assert.match(subjectsRoute, /updateTeacherClassSubjects\(/);
  assert.doesNotMatch(subjectsRoute, /writingDecision/);
  assert.doesNotMatch(subjectsRoute, /WRITING_DECISION_REQUIRED/);
  const memberRoute = read("app/api/teacher/classes/[classId]/members/[studentId]/route.ts");
  assert.match(memberRoute, /removeTeacherClassMember\(/);
  assert.doesNotMatch(memberRoute, /writingDecision/);
  assert.doesNotMatch(memberRoute, /WRITING_DECISION_REQUIRED/);

  const detail = read("components/teacher/TeacherClassDetail.tsx");
  assert.doesNotMatch(detail, /是否继续接收/);
  assert.doesNotMatch(detail, /继续接收|不再接收/);
  assert.doesNotMatch(detail, /writingDecision/);
  // The detail modal and the home class list share one client request helper.
  assert.match(detail, /updateTeacherClassSubjectsRequest/);
  const client = read("lib/teacherClassClient.ts");
  assert.match(client, /export async function updateTeacherClassSubjectsRequest/);
  assert.match(client, /applyClassSubjectsMutation/);
  const classList = read("components/teacher/TeacherClassList.tsx");
  assert.match(classList, /updateTeacherClassSubjectsRequest/);
  assert.match(classList, /applyClassSubjectsMutation/);
  assert.doesNotMatch(classList, /teacher_student_bindings|student-bindings/);
});

test("classes never create a teacher-student relation from an arbitrary id", () => {
  const server = read("lib/teacherClasses.server.ts");
  assert.match(server, /listVisibleStudentIds\(db, actor\)/);
  assert.match(server, /findInvisibleExistingMember/);
  assert.match(server, /所选学生中包含无效账号。/);
  const sync = rpcBlock("sync_class_members");
  assert.match(sync, /join public\.teacher_student_bindings binding[\s\S]{0,120}related_count <> requested_count/);
});

test("only the owning teacher can read or operate a class", () => {
  for (const routeFile of [
    "app/api/teacher/classes/route.ts",
    "app/api/teacher/classes/[classId]/route.ts",
    "app/api/teacher/classes/[classId]/members/route.ts",
    "app/api/teacher/classes/[classId]/members/[studentId]/route.ts",
    "app/api/teacher/classes/students/route.ts",
    "app/api/teacher/writing/review-classes/route.ts"
  ]) {
    const source = read(routeFile);
    assert.match(source, /requireTeacherOnly\(bearerToken\(request\)\)/, `${routeFile} must require a teacher session`);
  }
  const server = read("lib/teacherClasses.server.ts");
  assert.match(server, /\.eq\("class_id", classId\)\s*\.eq\("teacher_id", teacherId\)/);
  const assignRpc = rpcBlock("create_writing_assignment_group");
  assert.match(assignRpc, /if not found then\s*\n\s*raise exception 'CLASS_NOT_FOUND'/);
});

// Shared helpers used by the pages
test("class helpers keep the business representations consistent", () => {
  assert.deepEqual(normalizeClassSubjects(["writing", "reading", "writing"]), [
    "reading",
    "writing"
  ]);
  assert.deepEqual(normalizeClassSubjects(["unknown"]), []);
  assert.equal(classSubjectsLabel(["writing", "reading"]), "阅读、写作");
  assert.equal(validateClassName("  周六 写作班 ").ok, true);
  assert.equal(validateClassName("").ok, false);
  assert.equal(validateClassName("x".repeat(61)).ok, false);

  const parsed = parseClassMemberInputs([
    { kind: "existing", student_id: "student-1" },
    { kind: "new", student_name: "张三", account: "zhangsan", account_edited: false }
  ]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.members.length, 2);
  const duplicate = parseClassMemberInputs([
    { kind: "existing", student_id: "student-1" },
    { kind: "existing", student_id: "student-1" }
  ]);
  assert.equal(duplicate.ok, false);
  const missingName = parseClassMemberInputs([{ kind: "new", student_name: " ", account: "a" }]);
  assert.equal(missingName.ok, false);
  assert.equal(missingName.member_index, 0);

  const sorted = filterClassSummariesByName(
    [
      { class_id: "b", name: "写作班" },
      { class_id: "a", name: "阅读班" }
    ],
    "写作"
  );
  assert.deepEqual(sorted.map((entry) => entry.class_id), ["b"]);
});
