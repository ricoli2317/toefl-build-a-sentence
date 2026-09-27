import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compareWritingSubmissionsBySubmittedAtDesc,
  isWritingTaskType
} from "../lib/writing.ts";
import {
  collectWritingReviewStudentOptions,
  filterWritingReviewListEntries,
  isWritingReviewListStatus
} from "../lib/teacherWritingReviewList.ts";
import {
  parseTeacherWritingReviewListSearchParams,
  safeWritingReviewReturnTo,
  teacherWritingReviewWorkspaceHref,
  teacherWritingReviewsListHref
} from "../lib/teacherWritingReviewNavigation.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(resolve(projectRoot, relativePath), "utf8");

function reviewRow(overrides) {
  return {
    attemptId: overrides.attemptId,
    studentId: overrides.studentId ?? "student-a",
    studentName: overrides.studentName ?? "张三",
    taskType: overrides.taskType ?? "email",
    reviewStatus: overrides.reviewStatus ?? "pending",
    submittedAt: overrides.submittedAt ?? "2026-09-01T00:00:00.000Z"
  };
}

// 1 + 2 + 3: every review list shares one authoritative submitted_at DESC
// order with a stable unique secondary sort.
test("writing submissions sort by submitted_at DESC with a stable attempt id tiebreaker", () => {
  const older = { attempt_id: "attempt-b", submitted_at: "2026-09-01T00:00:00.000Z" };
  const newer = { attempt_id: "attempt-a", submitted_at: "2026-09-20T00:00:00.000Z" };
  const tieLow = { attempt_id: "attempt-c", submitted_at: "2026-09-20T00:00:00.000Z" };
  const missing = { attempt_id: "attempt-d", submitted_at: null };

  const sorted = [older, missing, tieLow, newer].sort(
    compareWritingSubmissionsBySubmittedAtDesc
  );
  assert.deepEqual(
    sorted.map((row) => row.attempt_id),
    ["attempt-c", "attempt-a", "attempt-b", "attempt-d"]
  );
  assert.equal(compareWritingSubmissionsBySubmittedAtDesc(newer, newer), 0);

  // Repeated runs and reversed inputs keep the exact same order.
  const fromReversed = [missing, tieLow, newer, older].sort(
    compareWritingSubmissionsBySubmittedAtDesc
  );
  assert.deepEqual(
    fromReversed.map((row) => row.attempt_id),
    ["attempt-c", "attempt-a", "attempt-b", "attempt-d"]
  );

  // The API applies this comparator to the merged self-practice + assignment
  // rows, so both tabs and every class drill-down share the one order and the
  // client never re-sorts.
  const route = read("app/api/teacher/writing/reviews/route.ts");
  assert.match(route, /\.sort\(compareWritingSubmissionsBySubmittedAtDesc\)/);
  const list = read("components/teacher/TeacherWritingReviewList.tsx");
  assert.doesNotMatch(list, /\.sort\(/);
});

// 4 + 5 + 6 + 7: 学生 ∩ 批改状态 ∩ 题型 (AND, one change never drops the others).
test("student tab filters combine student, status and task type with AND", () => {
  const rows = [
    reviewRow({ attemptId: "1", studentId: "zhang", studentName: "张三", taskType: "email", reviewStatus: "pending" }),
    reviewRow({ attemptId: "2", studentId: "zhang", studentName: "张三", taskType: "academic_discussion", reviewStatus: "published" }),
    reviewRow({ attemptId: "3", studentId: "li", studentName: "李四", taskType: "email", reviewStatus: "pending" }),
    reviewRow({ attemptId: "4", studentId: "li", studentName: "李四", taskType: "email", reviewStatus: "published" })
  ];
  const ids = (filters) =>
    filterWritingReviewListEntries(rows, filters).map((row) => row.attemptId);

  assert.deepEqual(ids({}), ["1", "2", "3", "4"]);
  assert.deepEqual(ids({ studentId: "zhang" }), ["1", "2"]);
  assert.deepEqual(ids({ studentId: "zhang", status: "pending" }), ["1"]);
  assert.deepEqual(ids({ studentId: "zhang", taskType: "email" }), ["1"]);
  assert.deepEqual(
    ids({ studentId: "zhang", status: "pending", taskType: "email" }),
    ["1"]
  );
  // 张三 + 待批改 + WE only returns rows satisfying all three.
  assert.deepEqual(ids({ studentId: "li", status: "pending", taskType: "academic_discussion" }), []);
  assert.deepEqual(ids({ status: "all", taskType: "all", studentId: "li" }), ["3", "4"]);

  // Both tabs run the shared predicate with all three values together.
  const list = read("components/teacher/TeacherWritingReviewList.tsx");
  assert.match(
    list,
    /filterWritingReviewListEntries\(attempts, \{\s*studentId: activeStudentId,\s*status: statusFilter,\s*taskType: taskFilter\s*\}\)/
  );
  assert.match(
    list,
    /filterWritingReviewListEntries\(attempts, \{\s*status: statusFilter,\s*taskType: taskFilter\s*\}\)/
  );
});

// 8 + 9 + 10 + 11: the class tab applies the same status ∩ task type view to
// the class-scoped rows.
test("class tab filters reuse the same combined predicate", () => {
  const rows = [
    reviewRow({ attemptId: "a-1", studentId: "s1", taskType: "email", reviewStatus: "pending" }),
    reviewRow({ attemptId: "a-2", studentId: "s2", taskType: "academic_discussion", reviewStatus: "reviewing" }),
    reviewRow({ attemptId: "a-3", studentId: "s3", taskType: "email", reviewStatus: "published" })
  ];
  const ids = (filters) =>
    filterWritingReviewListEntries(rows, filters).map((row) => row.attemptId);
  assert.deepEqual(ids({ status: "pending" }), ["a-1"]);
  assert.deepEqual(ids({ status: "pending", taskType: "academic_discussion" }), []);
  assert.deepEqual(ids({ status: "published", taskType: "email" }), ["a-3"]);
  assert.deepEqual(ids({ status: "reviewing", taskType: "academic_discussion" }), ["a-2"]);
});

test("student filter options stay scoped, distinct and name-sorted", () => {
  const options = collectWritingReviewStudentOptions([
    reviewRow({ attemptId: "1", studentId: "s2", studentName: "李四" }),
    reviewRow({ attemptId: "2", studentId: "s1", studentName: "张三" }),
    reviewRow({ attemptId: "3", studentId: "s1", studentName: "张三" })
  ]);
  assert.deepEqual(options, [
    { student_id: "s2", student_name: "李四" },
    { student_id: "s1", student_name: "张三" }
  ]);
});

// 12 + 13 + 14: the class tab never mixes classes, direct assignments or
// Reading-only classes.
test("class review scope stays limited to the teacher's own writing classes", () => {
  const route = read("app/api/teacher/writing/reviews/route.ts");
  assert.match(route, /listClassAssignmentIds\(supabase, auth\.userId, requestedClassId\)/);
  assert.match(route, /const assignmentIds = classAssignmentIds \?\? ownAssignmentIds;/);
  assert.match(route, /classAssignmentIds !== null \|\| writingStudentIds\.length === 0/);

  const list = read("components/teacher/TeacherWritingReviewList.tsx");
  assert.match(list, /loadWritingReviews\(`\?classId=\$\{encodeURIComponent\(classId\)\}`\)/);
  assert.match(list, /classOptions\.some\(\(entry\) => entry\.class_id === classId\)/);

  const server = read("lib/teacherClasses.server.ts");
  assert.match(server, /entry\.subjects\.includes\("writing"\)/);

  // The class filter options come from the Writing-only review classes API.
  assert.match(list, /loadClassReviewSummaries/);
  assert.match(list, /\/api\/teacher\/writing\/review-classes/);
});

// 15 + 16 + 17 + 18: URL initialization and deep-link recovery.
test("review list URL carries the tab, both filters and the safe fallbacks", () => {
  assert.equal(teacherWritingReviewsListHref({ tab: "students" }), "/teacher/writing/reviews");
  assert.equal(
    teacherWritingReviewsListHref({ tab: "students", studentId: "s1", status: "pending", taskType: "email" }),
    "/teacher/writing/reviews?studentId=s1&status=pending&taskType=email"
  );
  assert.equal(
    teacherWritingReviewsListHref({ tab: "class" }),
    "/teacher/writing/reviews?tab=class"
  );
  assert.equal(
    teacherWritingReviewsListHref({ tab: "class", classId: "c1", status: "reviewing", taskType: "academic_discussion" }),
    "/teacher/writing/reviews?tab=class&classId=c1&status=reviewing&taskType=academic_discussion"
  );
  // Only the active tab's own filter is written; "all" values are omitted.
  assert.equal(
    teacherWritingReviewsListHref({ tab: "class", studentId: "s1", status: "all", taskType: "all" }),
    "/teacher/writing/reviews?tab=class"
  );
  assert.equal(
    teacherWritingReviewsListHref({ tab: "students", classId: "c1" }),
    "/teacher/writing/reviews"
  );

  assert.deepEqual(parseTeacherWritingReviewListSearchParams(undefined), {
    tab: "students",
    classId: "",
    studentId: "",
    status: "all",
    taskType: "all"
  });
  assert.deepEqual(
    parseTeacherWritingReviewListSearchParams({
      tab: "class",
      classId: "c1",
      studentId: "s1",
      status: "published",
      taskType: "academic_discussion"
    }),
    {
      tab: "class",
      classId: "c1",
      studentId: "s1",
      status: "published",
      taskType: "academic_discussion"
    }
  );
  // Invalid values fall back safely instead of breaking the list.
  assert.equal(
    parseTeacherWritingReviewListSearchParams({ status: "banana", taskType: "reading" }).status,
    "all"
  );
  assert.equal(
    parseTeacherWritingReviewListSearchParams({ status: "banana", taskType: "reading" }).taskType,
    "all"
  );
  // Array params (repeated query keys) use the first value.
  assert.equal(
    parseTeacherWritingReviewListSearchParams({ tab: ["class", "students"] }).tab,
    "class"
  );

  assert.equal(isWritingReviewListStatus("reviewing"), true);
  assert.equal(isWritingReviewListStatus("banana"), false);
  assert.equal(isWritingTaskType("email"), true);

  const page = read("app/teacher/writing/reviews/page.tsx");
  assert.match(page, /parseTeacherWritingReviewListSearchParams/);
  const list = read("components/teacher/TeacherWritingReviewList.tsx");
  assert.match(list, /useState\(initialStudentId/);
  assert.match(list, /useState\(initialClassId/);
  assert.match(list, /useState<WritingReviewStatusFilter>\(initialStatus\)/);
  assert.match(list, /useState<WritingReviewTaskTypeFilter>\(initialTaskType\)/);
});

// 19: Back / Forward restore the filter state because the URL props are the
// source of truth and every filter click is a router.push.
test("filter changes go through the router and realign from the URL", () => {
  const list = read("components/teacher/TeacherWritingReviewList.tsx");
  assert.match(list, /router\.push\(href, \{ scroll: false \}\)/);
  assert.match(list, /router\.replace\(canonical, \{ scroll: false \}\)/);
  for (const [prop, setter] of [
    ["initialTab", "setTab"],
    ["initialStudentId", "setStudentId"],
    ["initialClassId", "setClassId"],
    ["initialStatus", "setStatusFilter"],
    ["initialTaskType", "setTaskFilter"]
  ]) {
    const pattern = new RegExp(
      `useEffect\\(\\(\\) => \\{\\s*${setter}\\([^;]*${prop}[^;]*\\);\\s*\\}, \\[${prop}\\]\\)`
    );
    assert.match(list, pattern, `${setter} must realign from ${prop}`);
  }
  assert.doesNotMatch(list, /history\.replaceState/);
});

// 20: the workspace returnTo keeps the full list query and survives validation.
test("workspace returnTo keeps the complete review list query", () => {
  const returnTo = teacherWritingReviewsListHref({
    tab: "class",
    classId: "c1",
    status: "pending",
    taskType: "email"
  });
  assert.equal(
    returnTo,
    "/teacher/writing/reviews?tab=class&classId=c1&status=pending&taskType=email"
  );
  assert.equal(safeWritingReviewReturnTo(returnTo), returnTo);
  assert.equal(
    teacherWritingReviewWorkspaceHref("attempt-1", returnTo),
    `/teacher/writing/reviews/attempt-1?returnTo=${encodeURIComponent(returnTo)}`
  );
  const studentReturnTo = teacherWritingReviewsListHref({
    tab: "students",
    studentId: "s1",
    status: "published"
  });
  assert.equal(safeWritingReviewReturnTo(studentReturnTo), studentReturnTo);
});

// The shared popovers keep the 作业管理 rendering for both callers.
test("shared student/class popovers stay reused by the assignments page", () => {
  const shared = read("components/teacher/TeacherListFilters.tsx");
  assert.match(shared, /export function TeacherStudentFilterPopover/);
  assert.match(shared, /export function TeacherClassFilterPopover/);
  assert.match(shared, /export function TeacherReviewFilterBar/);
  assert.match(shared, /label="全部学生"/);
  assert.match(shared, /label="全部班级"/);
  assert.match(shared, />\s*批改状态\s*</);
  assert.match(shared, />\s*题型\s*</);

  const assignments = read("components/teacher/TeacherWritingAssignmentsPageClient.tsx");
  assert.match(assignments, /TeacherStudentFilterPopover/);
  assert.match(assignments, /TeacherClassFilterPopover/);
  assert.doesNotMatch(assignments, /function TeacherAssignmentStudentFilter/);

  const list = read("components/teacher/TeacherWritingReviewList.tsx");
  assert.match(list, /TeacherReviewFilterBar/);
  assert.match(list, /TeacherStudentFilterPopover/);
  assert.match(list, /TeacherClassFilterPopover/);
  assert.match(list, /primaryLabel="学生"/);
  assert.match(list, /primaryLabel="班级"/);
});
