const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  assignmentGroupProgress,
  assignmentGroupProgressText,
  assignmentGroupStatusBadgeClass,
  assignmentGroupStatusLabel,
  collectWritingAssignmentStudentProgress,
  isTeacherAssignmentStudentCompleted,
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
const SHARED = "components/assignments/AssignmentPresentation.tsx";
const STUDENT_UI = "components/student/StudentWritingAssignments.tsx";

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

test("the group badge keeps the three shared states and the historical tones", () => {
  const notStarted = assignmentGroupProgress({ completedCount: 0, totalCount: 3 });
  const inProgress = assignmentGroupProgress({ completedCount: 1, totalCount: 3 });
  const completed = assignmentGroupProgress({ completedCount: 3, totalCount: 3 });
  const withdrawn = assignmentGroupProgress({
    completedCount: 1,
    lifecycleStatus: "withdrawn",
    totalCount: 3
  });
  assert.equal(notStarted.label, "未完成");
  assert.equal(notStarted.badgeClass, "bg-amber-50 text-amber-700");
  assert.equal(inProgress.label, "进行中");
  assert.equal(inProgress.badgeClass, "bg-student-primary-soft text-student-primary");
  assert.equal(completed.label, "已完成");
  assert.equal(completed.badgeClass, "bg-emerald-50 text-emerald-700");
  assert.equal(withdrawn.label, "已撤回");
  assert.equal(withdrawn.badgeClass, "bg-slate-100 text-slate-600");
  assert.equal(new Set([notStarted.badgeClass, inProgress.badgeClass, completed.badgeClass, withdrawn.badgeClass]).size, 4);
  // The former group-level labels never come back on top.
  for (const removed of ["已提交", "部分已提交", "部分已完成", "全部已提交", "待批改", "已发布"]) {
    assert.notEqual(notStarted.label, removed);
    assert.notEqual(inProgress.label, removed);
    assert.notEqual(completed.label, removed);
  }
});

test("the shared progress contract is untouched while both ends use one badge helper", () => {
  assert.equal(assignmentGroupStatusLabel("not_started"), "未完成");
  assert.equal(assignmentGroupStatusLabel("in_progress"), "进行中");
  assert.equal(assignmentGroupStatusLabel("completed"), "已完成");
  assert.equal(assignmentGroupStatusLabel("withdrawn"), "已撤回");
  assert.equal(assignmentGroupStatusBadgeClass("not_started"), "bg-amber-50 text-amber-700");
  assert.equal(assignmentGroupStatusBadgeClass("in_progress"), "bg-student-primary-soft text-student-primary");
  assert.equal(assignmentGroupStatusBadgeClass("completed"), "bg-emerald-50 text-emerald-700");
  assert.equal(assignmentGroupProgressText(0, 3), "0 / 3 已完成");
  assert.equal(assignmentGroupProgressText(3, 3), "3 / 3 已完成");

  // WE / AD complete only through a published review; read-only items through
  // their own result inside the Assignment window.
  assert.equal(
    isTeacherAssignmentStudentCompleted({ itemType: "email", hasResult: false, publishedReview: false }),
    false
  );
  assert.equal(
    isTeacherAssignmentStudentCompleted({ itemType: "email", hasResult: true, publishedReview: true }),
    true
  );
  assert.equal(
    isTeacherAssignmentStudentCompleted({ itemType: "build_sentence", hasResult: true, publishedReview: false }),
    true
  );

  // The teacher list / detail and the student UI all resolve the tone through
  // the one shared presentation component instead of local color chains.
  const list = source(LIST);
  assert.match(list, /AssignmentStatusBadge/);
  assert.match(source(DETAIL_BODY), /AssignmentStatusBadge/);
  assert.match(source(COLLECTION_DETAIL), /TeacherWritingAssignmentDetailBody/);
  assert.match(source(STUDENT_UI), /AssignmentStatusBadge/);
  const shared = source(SHARED);
  assert.match(shared, /assignmentGroupProgress\(\{ completedCount, lifecycleStatus, totalCount \}\)/);
  assert.match(shared, /assignmentGroupProgressText\(completedCount, totalCount\)/);
  assert.equal(typeof assignmentGroupProgress, "function");
});

test("every teacher Assignment Detail renders the same shared body and title rules", () => {
  const detail = source(DETAIL);
  const collectionDetail = source(COLLECTION_DETAIL);
  const body = source(DETAIL_BODY);
  const shared = source(SHARED);
  assert.match(detail, /<TeacherWritingAssignmentDetailBody/);
  assert.match(collectionDetail, /<TeacherWritingAssignmentDetailBody/);
  // The heading is always the Assignment / Assignment Group title, rendered by
  // the one shared detail header.
  assert.match(detail, /group_title\?\.trim\(\)[\s\S]{0,80}writingAssignmentTitle\(assignment\.question_snapshot\)/);
  assert.match(collectionDetail, /collection\.title\?\.trim\(\)/);
  assert.match(body, /<AssignmentDetailHeaderCard/);
  assert.match(shared, /text-xl font-bold text-student-text">\{title\}/);
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
  assert.match(body, /<AssignmentItemHeading/);
  assert.match(body, /<StudentWritingProgressBadge progress=\{studentProgress\} \/>/);
  assert.match(body, /等待提交/);
  // The item heading shell keeps the visible 第 N 篇 · 题型 structure.
  const shared = source(SHARED);
  assert.match(shared, /第 \$\{index \+ 1\} 篇 · /);
});

test("question preview and question progress are gone from Assignment Detail only", () => {
  const detail = source(DETAIL);
  const collectionDetail = source(COLLECTION_DETAIL);
  const body = source(DETAIL_BODY);
  assert.doesNotMatch(detail, /WritingAssignmentQuestionPreview|题目预览/);
  assert.doesNotMatch(collectionDetail, /题目进度/);
  assert.doesNotMatch(body, /题目进度|题目预览|WritingAssignmentQuestionPreview/);
  // The题库编辑入口 keep their full question preview (out of scope): the one
  // shared wizard owns it, and the withdrawn editors only seed that wizard.
  assert.match(source(CREATE_FORM), /WritingAssignmentQuestionPreview/);
  assert.match(source(GROUP_EDIT_FORM), /TeacherWritingAssignmentForm/);
});

test("question source badges are no longer rendered on teacher assignment cards or detail", () => {
  for (const relativePath of [LIST, DETAIL, COLLECTION_DETAIL, DETAIL_BODY]) {
    const ui = source(relativePath);
    assert.doesNotMatch(ui, /question_source === "custom"/);
    assert.doesNotMatch(ui, /题库题目|自定义题目|>"题库"|"自定义"/);
  }
  // The creation and edit flows keep recognizing bank vs custom questions.
  assert.match(source(CREATE_FORM), /question_source/);
  assert.match(source(GROUP_EDIT_FORM), /TeacherWritingAssignmentForm/);
  // Task type badges and counts stay exactly as before.
  assert.deepEqual(
    writingAssignmentTaskTypeBadges(["email", "academic_discussion", "academic_discussion"]),
    ["Write an Email", "Academic Discussion ×2"]
  );
  assert.match(source(LIST), /writingAssignmentTaskTypeBadges\(\[assignment\.task_type\]\)/);
  assert.match(source(DETAIL_BODY), /writingAssignmentTaskTypeBadges\(assignments\.map\(\(assignment\) => assignment\.task_type\)\)/);
});
