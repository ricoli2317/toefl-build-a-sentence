const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  collectWritingAssignmentStudentProgress,
  getTeacherAssignmentCollectionProgress,
  getTeacherAssignmentProgress,
  getWritingAssignmentCollectionProgress,
  getWritingAssignmentProgress,
  writingAssignmentProgressBadgeClass,
  writingAssignmentTaskTypeBadges
} = require("../lib/writingAssignments.ts");

const projectRoot = path.resolve(__dirname, "..");
const source = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const LIST = "components/teacher/TeacherWritingAssignmentList.tsx";
const DETAIL = "components/teacher/TeacherWritingAssignmentDetailView.tsx";
const COLLECTION_DETAIL = "components/teacher/TeacherWritingAssignmentCollectionDetailView.tsx";
const DETAIL_BODY = "components/teacher/TeacherWritingAssignmentDetailBody.tsx";
const CREATE_FORM = "components/teacher/TeacherWritingAssignmentForm.tsx";
const GROUP_EDIT_FORM = "components/teacher/TeacherWritingAssignmentGroupEditForm.tsx";
const DETAIL_ROUTE = "app/api/teacher/writing/assignments/[assignmentId]/route.ts";

function student(studentId, overrides = {}) {
  return {
    student_id: studentId,
    student_name: `学生${studentId}`,
    student_email: `${studentId}@example.com`,
    assigned_at: "2026-09-01T00:00:00.000Z",
    first_submitted_at: null,
    has_attempt: false,
    latest_submitted_attempt_id: null,
    latest_review_status: null,
    status: "pending",
    ...overrides
  };
}

function assignment(assignmentId, students) {
  return {
    assignment_id: assignmentId,
    group_id: "g1",
    group_position: 1,
    task_type: "email",
    question_source: "question_bank",
    question_id: "EMAIL-1",
    question_snapshot: { set_title: "Question" },
    display_name: `题目 ${assignmentId}`,
    status: "active",
    due_at: null,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    assigned_count: students.length,
    completed_count: 0,
    published_count: 0,
    has_attempts: false,
    has_submitted_attempts: false,
    students
  };
}

test("assignment status badge colors restore the historical four-tone mapping", () => {
  const ongoing = writingAssignmentProgressBadgeClass("ongoing");
  const partial = writingAssignmentProgressBadgeClass("partial_submitted");
  const submitted = writingAssignmentProgressBadgeClass("submitted");
  const allSubmitted = writingAssignmentProgressBadgeClass("all_submitted");
  const completed = writingAssignmentProgressBadgeClass("completed");
  const withdrawn = writingAssignmentProgressBadgeClass("withdrawn");
  // 进行中 / 部分已提交 / 已完成 / 已撤回 all keep distinct variants again.
  assert.equal(ongoing, "bg-student-primary-soft text-student-primary");
  assert.equal(partial, "bg-amber-50 text-amber-700");
  assert.equal(completed, "bg-emerald-50 text-emerald-700");
  assert.equal(withdrawn, "bg-slate-100 text-slate-600");
  assert.equal(submitted, partial);
  assert.equal(allSubmitted, partial);
  assert.equal(new Set([ongoing, partial, completed, withdrawn]).size, 4);
});

test("status computation is untouched while cards and detail headers share one tone helper", () => {
  // Business labels keep the exact existing progress logic.
  assert.deepEqual(
    getWritingAssignmentProgress({
      assignedCount: 3,
      lifecycleStatus: "active",
      publishedCount: 0,
      submittedCount: 0
    }),
    { label: "进行中", progress: "ongoing" }
  );
  assert.deepEqual(
    getWritingAssignmentProgress({
      assignedCount: 3,
      lifecycleStatus: "active",
      publishedCount: 0,
      submittedCount: 1
    }),
    { label: "1 人已提交", progress: "partial_submitted" }
  );
  assert.deepEqual(
    getWritingAssignmentProgress({
      assignedCount: 3,
      lifecycleStatus: "active",
      publishedCount: 3,
      submittedCount: 3
    }),
    { label: "已完成", progress: "completed" }
  );
  assert.deepEqual(
    getWritingAssignmentProgress({
      assignedCount: 3,
      lifecycleStatus: "withdrawn",
      publishedCount: 0,
      submittedCount: 0
    }),
    { label: "已撤回", progress: "withdrawn" }
  );
  // Group cards keep their existing labels too.
  assert.deepEqual(
    getWritingAssignmentCollectionProgress({
      completedCount: 0,
      publishedCount: 0,
      totalCount: 2,
      withdrawn: false
    }),
    { label: "进行中", progress: "ongoing" }
  );
  assert.deepEqual(
    getWritingAssignmentCollectionProgress({
      completedCount: 1,
      publishedCount: 0,
      totalCount: 2,
      withdrawn: false
    }),
    { label: "部分已提交", progress: "partial_submitted" }
  );
  assert.deepEqual(
    getWritingAssignmentCollectionProgress({
      completedCount: 2,
      publishedCount: 0,
      totalCount: 2,
      withdrawn: false
    }),
    { label: "全部已提交", progress: "all_submitted" }
  );
  assert.deepEqual(
    getWritingAssignmentCollectionProgress({
      completedCount: 2,
      publishedCount: 2,
      totalCount: 2,
      withdrawn: false
    }),
    { label: "已完成", progress: "completed" }
  );

  // Student card, class card and both detail headers resolve the tone through
  // the one helper instead of local color chains.
  const list = source(LIST);
  assert.match(list, /writingAssignmentProgressBadgeClass\(progress\.progress\)/);
  // The card / detail adapter maps read-only Assignments (BAS / 阅读) onto the
  // existing 已完成 state instead of inventing a new badge.
  assert.match(list, /getTeacherAssignmentCollectionProgress\(/);
  assert.match(list, /getTeacherAssignmentProgress\(/);
  assert.doesNotMatch(list, /progressClassName/);
  assert.match(source(DETAIL_BODY), /writingAssignmentProgressBadgeClass\(progress\.progress\)/);
  assert.match(source(COLLECTION_DETAIL), /getTeacherAssignmentCollectionProgress\(/);
  assert.equal(typeof getTeacherAssignmentCollectionProgress, "function");
  assert.deepEqual(
    getTeacherAssignmentCollectionProgress({
      completedCount: 2,
      itemTypes: ["rdl", "rap"],
      publishedCount: 0,
      totalCount: 2,
      withdrawn: false
    }),
    { label: "已完成", progress: "completed" }
  );
  assert.deepEqual(
    getTeacherAssignmentProgress({
      assignedCount: 1,
      completedCount: 1,
      itemTypes: ["build_sentence"],
      lifecycleStatus: "active",
      publishedCount: 0
    }),
    { label: "已完成", progress: "completed" }
  );
});

test("every teacher Assignment Detail renders the same body and title rules", () => {
  const detail = source(DETAIL);
  const collectionDetail = source(COLLECTION_DETAIL);
  const body = source(DETAIL_BODY);
  assert.match(detail, /<TeacherWritingAssignmentDetailBody/);
  assert.match(collectionDetail, /<TeacherWritingAssignmentDetailBody/);
  // The heading is always the Assignment / Assignment Group title.
  assert.match(detail, /group_title\?\.trim\(\)[\s\S]{0,80}writingAssignmentTitle\(assignment\.question_snapshot\)/);
  assert.match(collectionDetail, /collection\.title\?\.trim\(\)/);
  assert.match(body, /font-bold text-student-text">\{title\}/);
  // The detail route resolves the persisted group title like the list does.
  const route = source(DETAIL_ROUTE);
  assert.match(route, /loadWritingAssignmentGroupTitles/);
  assert.match(route, /group_title: groupTitles\.get/);
});

test("student completion is one card per student and one row per assignment", () => {
  const oneStudent = [student("s1", { latest_submitted_attempt_id: "a1", status: "completed" })];
  const twoStudents = [student("s1"), student("s2")];
  const singleOne = assignment("a1", oneStudent);
  const singleTwo = assignment("a2", twoStudents);
  const first = assignment("a1", [student("s1"), student("s2")]);
  const second = assignment("a2", [student("s1")]);

  // 1 student x 1 assignment -> 1 card, 1 row.
  const single = collectWritingAssignmentStudentProgress([singleOne]);
  assert.equal(single.length, 1);
  assert.equal(single[0].assignments.length, 1);
  assert.equal(single[0].assignments[0].progress.latest_submitted_attempt_id, "a1");

  // 1 student x 2 assignments -> 1 card, 2 rows.
  const singleStudentMulti = collectWritingAssignmentStudentProgress([
    assignment("a1", [student("s1")]),
    assignment("a2", [student("s1")])
  ]);
  assert.equal(singleStudentMulti.length, 1);
  assert.equal(singleStudentMulti[0].assignments.length, 2);

  // 2 students x 1 assignment -> 2 cards, 1 row each.
  const multiStudentSingle = collectWritingAssignmentStudentProgress([singleTwo]);
  assert.equal(multiStudentSingle.length, 2);
  assert.equal(multiStudentSingle.every((entry) => entry.assignments.length === 1), true);

  // A recipient missing from one assignment still gets its pending row.
  const missing = collectWritingAssignmentStudentProgress([
    assignment("a1", [student("s1"), student("s2")]),
    assignment("a2", [student("s1")])
  ]);
  assert.equal(missing.length, 2);
  assert.equal(missing[1].assignments[1].progress.status, "pending");
  assert.equal(missing[1].assignments[1].progress.latest_submitted_attempt_id, null);

  // The shared body maps that model to the preserved card + table markup.
  const body = source(DETAIL_BODY);
  assert.match(body, /collectWritingAssignmentStudentProgress\(assignments\)/);
  assert.match(body, /students\.map\(\(student\)/);
  assert.match(body, /student\.assignments\.map\(/);
  assert.match(body, /第 \{index \+ 1\} 篇 · \{assignmentItemTypeLabel\(assignment\.task_type\)\}/);
  assert.match(body, /<StudentWritingProgressBadge progress=\{studentProgress\} \/>/);
  assert.match(body, /等待提交/);
});

test("question preview and question progress are gone from Assignment Detail only", () => {
  const detail = source(DETAIL);
  const collectionDetail = source(COLLECTION_DETAIL);
  const body = source(DETAIL_BODY);
  assert.doesNotMatch(detail, /WritingAssignmentQuestionPreview|题目预览/);
  assert.doesNotMatch(collectionDetail, /题目进度/);
  assert.doesNotMatch(body, /题目进度|题目预览|WritingAssignmentQuestionPreview/);
  // The题库/编辑入口 keep their full question preview (out of scope).
  assert.match(source(CREATE_FORM), /WritingAssignmentQuestionPreview/);
  assert.match(source(GROUP_EDIT_FORM), /WritingAssignmentQuestionPreview/);
});

test("question source badges are no longer rendered on teacher assignment cards or detail", () => {
  for (const relativePath of [LIST, DETAIL, COLLECTION_DETAIL, DETAIL_BODY]) {
    const ui = source(relativePath);
    assert.doesNotMatch(ui, /question_source === "custom"/);
    assert.doesNotMatch(ui, /题库题目|自定义题目|>"题库"|"自定义"/);
  }
  // The creation and edit flows keep recognizing bank vs custom questions.
  assert.match(source(CREATE_FORM), /question_source/);
  assert.match(source(GROUP_EDIT_FORM), /question_source/);
  // Task type badges and counts stay exactly as before.
  assert.deepEqual(
    writingAssignmentTaskTypeBadges(["email", "academic_discussion", "academic_discussion"]),
    ["Write an Email", "Academic Discussion ×2"]
  );
  assert.match(source(LIST), /writingAssignmentTaskTypeBadges\(\[assignment\.task_type\]\)/);
  assert.match(source(DETAIL_BODY), /writingAssignmentTaskTypeBadges\(assignments\.map\(\(assignment\) => assignment\.task_type\)\)/);
});
