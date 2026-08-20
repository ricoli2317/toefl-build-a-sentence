const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  compareStudentWritingAssignments,
  getStudentWritingAssignmentDisplayStatus,
  getWritingAssignmentProgress,
  groupStudentWritingAssignments,
  groupTeacherWritingAssignments,
  studentWritingAssignmentDisplayStatusLabel
} = require("../lib/writingAssignments.ts");
const {
  DEFAULT_STUDENT_WRITING_MODE_AVAILABILITY,
  isStudentWritingModeAllowed,
  normalizeStudentWritingModeAvailability
} = require("../lib/writingModePolicy.ts");

const projectRoot = path.resolve(__dirname, "..");
const source = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

test("writing mode policy defaults both existing modes to enabled", () => {
  assert.deepEqual(
    normalizeStudentWritingModeAvailability(null),
    DEFAULT_STUDENT_WRITING_MODE_AVAILABILITY
  );
  assert.equal(
    isStudentWritingModeAllowed(DEFAULT_STUDENT_WRITING_MODE_AVAILABILITY, "practice"),
    true
  );
  assert.equal(
    isStudentWritingModeAllowed(DEFAULT_STUDENT_WRITING_MODE_AVAILABILITY, "exam"),
    true
  );
});

test("a student-level setting disables practice without disabling exam", () => {
  const availability = normalizeStudentWritingModeAvailability({
    practice_mode_enabled: false
  });
  assert.deepEqual(availability, {
    practiceModeEnabled: false,
    mockModeEnabled: true
  });
  assert.equal(isStudentWritingModeAllowed(availability, "practice"), false);
  assert.equal(isStudentWritingModeAllowed(availability, "exam"), true);
});

test("student assignments sort overdue, pending, then completed with newest first", () => {
  const assignments = [
    { student_status: "completed", assigned_at: "2026-08-17T12:00:00Z", created_at: "" },
    { student_status: "pending", assigned_at: "2026-08-16T12:00:00Z", created_at: "" },
    { student_status: "overdue", assigned_at: "2026-08-15T12:00:00Z", created_at: "" },
    { student_status: "pending", assigned_at: "2026-08-17T12:00:00Z", created_at: "" },
    { student_status: "late_completed", assigned_at: "2026-08-18T12:00:00Z", created_at: "" }
  ];
  assignments.sort(compareStudentWritingAssignments);
  assert.deepEqual(
    assignments.map((assignment) => assignment.student_status),
    ["overdue", "pending", "pending", "late_completed", "completed"]
  );
  assert.equal(assignments[1].assigned_at, "2026-08-17T12:00:00Z");
});

test("student presentation status follows no attempt, draft, submission, and published review", () => {
  const base = {
    draft_attempt_id: null,
    due_at: "2026-08-21T00:00:00Z",
    latest_submitted_attempt_id: null,
    published_review_attempt_id: null
  };
  const now = new Date("2026-08-20T00:00:00Z");
  assert.equal(getStudentWritingAssignmentDisplayStatus(base, now), "not_started");
  assert.equal(getStudentWritingAssignmentDisplayStatus({ ...base, draft_attempt_id: "draft-1" }, now), "in_progress");
  assert.equal(getStudentWritingAssignmentDisplayStatus({ ...base, latest_submitted_attempt_id: "attempt-1" }, now), "submitted");
  assert.equal(getStudentWritingAssignmentDisplayStatus({ ...base, latest_submitted_attempt_id: "attempt-1", published_review_attempt_id: "attempt-1" }, now), "completed");
  assert.equal(getStudentWritingAssignmentDisplayStatus({ ...base, due_at: "2026-08-19T00:00:00Z" }, now), "overdue");
  assert.deepEqual(
    ["not_started", "in_progress", "submitted", "completed", "overdue"].map(studentWritingAssignmentDisplayStatusLabel),
    ["未开始", "进行中", "已提交", "已完成", "已逾期"]
  );
});

test("student assignment grouping keeps standalone work and collapses each multi-question batch", () => {
  const assignments = [
    { assignment_id: "standalone", group_id: null, group_position: null },
    { assignment_id: "second", group_id: "batch-1", group_position: 2 },
    { assignment_id: "first", group_id: "batch-1", group_position: 1 },
    { assignment_id: "single", group_id: "batch-2", group_position: 1 }
  ];
  const entries = groupStudentWritingAssignments(assignments);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].kind, "assignment");
  assert.equal(entries[1].kind, "collection");
  assert.deepEqual(entries[1].assignments.map((item) => item.assignment_id), ["first", "second"]);
  assert.equal(entries[2].kind, "assignment");
});

test("teacher assignment grouping aggregates submission and pending-review progress", () => {
  const common = {
    group_id: "batch-1",
    assigned_count: 2,
    created_at: "2026-08-20T00:00:00Z",
    has_overdue_students: false
  };
  const entries = groupTeacherWritingAssignments([
    { ...common, assignment_id: "first", group_position: 1, completed_count: 2, published_count: 1 },
    { ...common, assignment_id: "second", group_position: 2, completed_count: 1, published_count: 0 }
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "collection");
  assert.equal(entries[0].assigned_count, 2);
  assert.equal(entries[0].total_count, 4);
  assert.equal(entries[0].completed_count, 3);
  assert.equal(entries[0].pending_review_count, 2);
});

test("teacher assignment progress follows submission and published-review counts", () => {
  assert.deepEqual(getWritingAssignmentProgress({
    assignedCount: 1,
    lifecycleStatus: "active",
    publishedCount: 0,
    submittedCount: 0
  }), { label: "进行中", progress: "ongoing" });
  assert.deepEqual(getWritingAssignmentProgress({
    assignedCount: 1,
    lifecycleStatus: "active",
    publishedCount: 0,
    submittedCount: 1
  }), { label: "已提交", progress: "submitted" });
  assert.deepEqual(getWritingAssignmentProgress({
    assignedCount: 3,
    lifecycleStatus: "active",
    publishedCount: 1,
    submittedCount: 2
  }), { label: "2 人已提交", progress: "partial_submitted" });
  assert.deepEqual(getWritingAssignmentProgress({
    assignedCount: 3,
    lifecycleStatus: "active",
    publishedCount: 2,
    submittedCount: 3
  }), { label: "全部已提交", progress: "all_submitted" });
  assert.deepEqual(getWritingAssignmentProgress({
    assignedCount: 3,
    lifecycleStatus: "active",
    publishedCount: 3,
    submittedCount: 3
  }), { label: "已完成", progress: "completed" });
  assert.deepEqual(getWritingAssignmentProgress({
    assignedCount: 3,
    lifecycleStatus: "withdrawn",
    publishedCount: 3,
    submittedCount: 3
  }), { label: "已撤回", progress: "withdrawn" });
});

test("assignment entry reuses WritingPractice and its shared mode choice", () => {
  const assignmentUi = source("components/student/StudentWritingAssignments.tsx");
  const writingPractice = source("components/writing/WritingPractice.tsx");
  assert.match(assignmentUi, /<WritingPractice/);
  assert.match(assignmentUi, /assignmentId=\{assignment\.assignment_id\}/);
  assert.match(writingPractice, /function WritingModeChoice/);
  assert.match(writingPractice, /availability\.practiceModeEnabled/);
  assert.match(writingPractice, /availability\.mockModeEnabled/);
  assert.match(writingPractice, /assignmentId,/);
});

test("assignment practice stays mounted while list data refreshes silently", () => {
  const assignmentUi = source("components/student/StudentWritingAssignments.tsx");
  const cache = source("components/StudentDataCache.tsx");
  const practice = source("components/writing/WritingPractice.tsx");
  assert.match(assignmentUi, /loading: initialLoading/);
  assert.match(assignmentUi, /refreshing: backgroundRefreshing/);
  assert.match(assignmentUi, /window\.addEventListener\("focus", refreshAssignments\)/);
  assert.match(assignmentUi, /window\.setInterval\(refreshAssignments, 30_000\)/);
  assert.match(cache, /status: "refreshing"/);
  assert.match(cache, /current\.generation === generation/);
  assert.match(cache, /entry\?\.status === "success" \|\| entry\?\.status === "refreshing"/);
  assert.doesNotMatch(assignmentUi, /返回我的作业/);
  assert.match(practice, /if \(initialAttempt\.assignment_id\) \{[\s\S]*invalidate\(STUDENT_WRITING_OVERVIEW_CACHE_KEY\)/);
});

test("student assignment endpoint only returns active non-deleted work", () => {
  const route = source("app/api/writing/assignments/route.ts");
  assert.match(route, /\.eq\("status", "active"\)/);
  assert.match(route, /\.is\("deleted_at", null\)/);
  assert.match(route, /group_id,group_position/);
});

test("student and teacher multi-question pages reuse existing writing and review entry points", () => {
  const studentUi = source("components/student/StudentWritingAssignments.tsx");
  const teacherUi = source("components/teacher/TeacherWritingAssignmentCollectionDetailView.tsx");
  const teacherRoute = source("app/api/teacher/writing/assignments/batches/[batchId]/route.ts");
  assert.match(studentUi, /groupStudentWritingAssignments/);
  assert.match(studentUi, /<StudentWritingAssignmentCard/);
  assert.match(studentUi, /<WritingPractice/);
  assert.match(teacherUi, /getWritingAssignmentReviewAction/);
  assert.match(teacherUi, /teacherWritingReviewWorkspaceHref/);
  assert.match(teacherUi, /等待提交/);
  assert.match(teacherRoute, /from\("writing_attempts"\)/);
  assert.match(teacherRoute, /from\("writing_reviews"\)/);
  assert.doesNotMatch(teacherRoute, /\.(?:insert|update|delete)\(/i);
});

test("teacher assignment APIs count published reviews for the latest submission", () => {
  const listRoute = source("app/api/teacher/writing/assignments/route.ts");
  const detailRoute = source("app/api/teacher/writing/assignments/[assignmentId]/route.ts");
  const listUi = source("components/teacher/TeacherWritingAssignmentList.tsx");
  const detailUi = source("components/teacher/TeacherWritingAssignmentDetailView.tsx");
  assert.match(listRoute, /from\("writing_reviews"\)/);
  assert.match(listRoute, /review\.status === "published" && review\.published_at/);
  assert.match(listRoute, /published_count/);
  assert.match(detailRoute, /from\("writing_reviews"\)/);
  assert.match(detailRoute, /review\.status === "published" && review\.published_at/);
  assert.match(detailRoute, /published_count/);
  assert.match(listUi, /getWritingAssignmentProgress/);
  assert.match(detailUi, /getWritingAssignmentProgress/);
});

test("attempt APIs persist assignment_id and scope ordinary and assignment drafts", () => {
  const createRoute = source("app/api/writing/attempts/route.ts");
  const catalogRoute = source("app/api/writing/catalog/route.ts");
  assert.match(createRoute, /assignment_id: assignmentId \?\? null/);
  assert.match(createRoute, /query\.eq\("assignment_id", assignmentId\)/);
  assert.match(createRoute, /query\.is\("assignment_id", null\)/);
  assert.match(createRoute, /readAvailableStudentAssignment/);
  assert.match(catalogRoute, /\.is\("assignment_id", null\)/);
});

test("assignment snapshot reads never fall back to the mutable question bank", () => {
  for (const relativePath of ["lib/writingServer.ts", "lib/writingReviewSource.ts"]) {
    const file = source(relativePath);
    assert.match(file, /if \(assignmentId\)[\s\S]*question_snapshot/);
    assert.match(file, /return \{ data: null, error: null, questionSource: null \}/);
  }
});

test("custom assignment discussion uses fixed avatars while bank questions keep resolver avatars", () => {
  const practice = source("components/writing/WritingPractice.tsx");
  const review = source("components/student/StudentWritingReview.tsx");
  assert.match(practice, /assignmentQuestionSource === "custom"/);
  assert.match(practice, /resolveCustomAcademicDiscussionAvatar/);
  assert.match(review, /academicDiscussionAvatarSource=\{state\.data\.question_source\}/);
});

test("SQL scopes assignment drafts and defines the extensible student policy boundary", () => {
  const assignmentSql = source("supabase/writing_assignments.sql");
  const policySql = source("supabase/student_writing_mode_settings.sql");
  assert.match(assignmentSql, /writing_attempts_one_assignment_draft/);
  assert.match(assignmentSql, /status = 'draft' and assignment_id is null/);
  assert.match(assignmentSql, /WRITING_ASSIGNMENT_NOT_ASSIGNED/);
  assert.match(policySql, /create table if not exists public\.student_writing_mode_settings/);
  assert.match(policySql, /practice_mode_enabled boolean not null default true/);
  assert.match(policySql, /writing_attempts_require_allowed_mode/);
});
