const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  assignmentDateKey,
  assignmentDateRange,
  assignmentGroupProgress,
  assignmentGroupProgressText,
  assignmentMonthRange,
  compareStudentWritingAssignments,
  getStudentWritingAssignmentDisplayStatus,
  groupStudentWritingAssignments,
  groupTeacherWritingAssignments,
  hasStudentAssignmentItemStarted,
  isStudentAssignmentItemCompleted,
  isTeacherAssignmentStudentCompleted,
  studentAssignmentGroupDisplayStatus,
  studentAssignmentGroupProgress,
  studentAssignmentItemProgress,
  studentAssignmentItemStatusLabel,
  studentWritingAssignmentTitle,
  studentWritingAssignmentDisplayStatusLabel
} = require("../lib/writingAssignments.ts");
const {
  studentAssignmentPracticeHref,
  studentAssignmentResultHref
} = require("../lib/studentAssignmentPractice.ts");
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
  // Item-level WE / AD submissions keep the extra 等待批改 hint; read-only items
  // never grow a review stage.
  assert.equal(studentAssignmentItemStatusLabel("submitted", "email"), "已提交，等待批改");
  assert.equal(studentAssignmentItemStatusLabel("submitted", "academic_discussion"), "已提交，等待批改");
  assert.equal(studentAssignmentItemStatusLabel("submitted", "ctw"), "已提交");
  assert.equal(studentAssignmentItemStatusLabel("completed", "rdl"), "已完成");
  assert.equal(studentAssignmentItemStatusLabel("not_started", "full_set"), "未开始");
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

test("student assignment titles prefer current bank display and fall back to snapshots", () => {
  const question_snapshot = { set_title: "8.8A old raw title" };
  assert.equal(
    studentWritingAssignmentTitle({
      display_name: "题目023 Community Theater Rentals",
      question_snapshot
    }),
    "题目023 Community Theater Rentals"
  );
  assert.equal(
    studentWritingAssignmentTitle({ question_snapshot }),
    "8.8A old raw title"
  );
  assert.equal(
    studentWritingAssignmentTitle({ display_name: "", question_snapshot }),
    "8.8A old raw title"
  );
});

test("student assignment calendar reads only a database-bounded minimal month index", () => {
  const route = source("app/api/writing/assignments/calendar/route.ts");
  const ui = source("components/student/StudentWritingAssignments.tsx");
  assert.match(route, /from\("writing_assignment_students"\)/);
  assert.match(route, /\.gte\("assigned_at", range\.startInclusive\)/);
  assert.match(route, /\.lt\("assigned_at", range\.endExclusive\)/);
  assert.match(route, /title:question_snapshot->>set_title/);
  assert.match(route, /assignment_date: date/);
  assert.doesNotMatch(route, /writing_attempts|writing_reviews|response_text|question_snapshot,/);
  assert.match(ui, /assignmentItemTypeLabel\(assignment\.task_type\)\}: \{assignment\.title\}/);
  assert.doesNotMatch(ui, /prefetch/);
});

test("student assignment calendar resolves persisted group titles before bank display names", () => {
  const route = source("app/api/writing/assignments/calendar/route.ts");
  assert.match(route, /loadWritingAssignmentDisplayNames/);
  assert.match(route, /loadWritingAssignmentGroupTitles/);
  assert.match(route, /groupTitles\.get\(assignment\.group_id\)/);
  assert.match(route, /displayNames\.get\(assignmentId\)/);
  assert.doesNotMatch(route, /title: assignment\.title/);
});

test("student day and batch details resolve bank titles without bypassing the server helper", () => {
  const details = source("lib/studentWritingAssignments.server.ts");
  assert.match(details, /loadWritingAssignmentDisplayNames/);
  assert.match(details, /display_name: displayNames\.get\(assignment\.assignment_id\) \?\? assignment\.title/);
  assert.match(details, /title: assignment\.title,/);
  assert.doesNotMatch(details, /display_name: assignment\.title,/);
  for (const relativePath of [
    "app/api/writing/assignments/day/route.ts",
    "app/api/writing/assignments/batch/route.ts"
  ]) {
    assert.match(source(relativePath), /loadStudentAssignmentDetails/);
  }
});

test("desktop assignment calendar keeps fixed cells and summarizes overflow", () => {
  const ui = source("components/student/StudentWritingAssignments.tsx");
  assert.match(ui, /DESKTOP_CALENDAR_VISIBLE_ASSIGNMENTS = 2/);
  assert.match(ui, /assignments\.slice\(0, DESKTOP_CALENDAR_VISIBLE_ASSIGNMENTS\)/);
  assert.match(ui, /hiddenAssignmentCount > 0/);
  assert.match(ui, /另有\$\{hiddenAssignmentCount\}项作业/);
  assert.match(ui, /h-\[116px\][^"\n]*overflow-hidden/);
  assert.match(ui, /xl:h-\[132px\]/);
  assert.doesNotMatch(ui, /min-h-\[116px\]/);
});

test("desktop calendar keeps adjacent-month grid cells visually empty", () => {
  const ui = source("components/student/StudentWritingAssignments.tsx");
  assert.match(ui, /const content = cell\.inCurrentMonth \? \(/);
  assert.match(ui, /\) : null;/);
  assert.match(ui, /Math\.ceil\(\(mondayOffset \+ currentMonthDays\) \/ 7\) \* 7/);
  assert.doesNotMatch(ui, /Array\.from\(\{ length: 42 \}/);
});

test("assignment calendar ranges use Shanghai boundaries and real calendar dates", () => {
  assert.deepEqual(assignmentMonthRange("2026-12"), {
    startInclusive: "2026-12-01T00:00:00+08:00",
    endExclusive: "2027-01-01T00:00:00+08:00"
  });
  assert.deepEqual(assignmentDateRange("2026-08-17"), {
    startInclusive: "2026-08-17T00:00:00+08:00",
    endExclusive: "2026-08-18T00:00:00+08:00"
  });
  assert.equal(assignmentDateRange("2026-02-30"), null);
  assert.equal(assignmentDateKey("2026-08-16T16:30:00Z"), "2026-08-17");
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

test("the shared group status contract keeps exactly 未完成 / 进行中 / 已完成", () => {
  const notStarted = assignmentGroupProgress({ completedCount: 0, totalCount: 3 });
  assert.equal(notStarted.status, "not_started");
  assert.equal(notStarted.label, "未完成");
  assert.equal(notStarted.badgeClass, "bg-amber-50 text-amber-700");
  assert.equal(notStarted.progressText, "0 / 3 已完成");

  const inProgress = assignmentGroupProgress({ completedCount: 1, totalCount: 3 });
  assert.equal(inProgress.status, "in_progress");
  assert.equal(inProgress.label, "进行中");
  assert.equal(inProgress.badgeClass, "bg-student-primary-soft text-student-primary");
  assert.equal(inProgress.progressText, "1 / 3 已完成");

  const completed = assignmentGroupProgress({ completedCount: 3, totalCount: 3 });
  assert.equal(completed.status, "completed");
  assert.equal(completed.label, "已完成");
  assert.equal(completed.badgeClass, "bg-emerald-50 text-emerald-700");
  assert.equal(completed.progressText, "3 / 3 已完成");

  // A withdrawn group keeps its lifecycle badge instead of a progress state.
  const withdrawn = assignmentGroupProgress({
    completedCount: 2,
    lifecycleStatus: "withdrawn",
    totalCount: 3
  });
  assert.equal(withdrawn.badge, "withdrawn");
  assert.equal(withdrawn.label, "已撤回");
  assert.equal(withdrawn.badgeClass, "bg-slate-100 text-slate-600");
  assert.equal(withdrawn.progressText, "2 / 3 已完成");

  // The removed group labels never come back.
  for (const label of [notStarted, inProgress, completed].map((value) => value.label)) {
    assert.ok(!["已提交", "部分已提交", "部分已完成", "全部已提交", "待批改", "已发布"].includes(label));
  }
  assert.equal(assignmentGroupProgressText(2, 5), "2 / 5 已完成");
});

test("one item completion rule: WE / AD complete only on published review", () => {
  assert.equal(
    isTeacherAssignmentStudentCompleted({ itemType: "email", hasResult: false, publishedReview: false }),
    false
  );
  assert.equal(
    isTeacherAssignmentStudentCompleted({ itemType: "academic_discussion", hasResult: false, publishedReview: true }),
    true
  );
  assert.equal(
    isTeacherAssignmentStudentCompleted({ itemType: "ctw", hasResult: true, publishedReview: false }),
    true
  );
  assert.equal(
    isTeacherAssignmentStudentCompleted({ itemType: "full_set", hasResult: false, publishedReview: false }),
    false
  );
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

test("assignment caches are split by month, day, batch, and entry and share invalidation", () => {
  const assignmentUi = source("components/student/StudentWritingAssignments.tsx");
  const cache = source("components/StudentDataCache.tsx");
  const practice = source("components/writing/WritingPractice.tsx");
  assert.match(cache, /writing:assignments/);
  assert.match(cache, /:calendar:\$\{month\}/);
  assert.match(cache, /:day:\$\{date\}/);
  assert.match(cache, /:entry:\$\{assignmentId\}/);
  assert.match(cache, /:batch:\$\{batchId\}/);
  assert.match(cache, /invalidate\(STUDENT_WRITING_ASSIGNMENTS_CACHE_PREFIX\)/);
  assert.match(assignmentUi, /loadStudentWritingAssignmentCalendar/);
  assert.match(assignmentUi, /loadStudentWritingAssignmentsDay/);
  assert.match(cache, /status: "refreshing"/);
  assert.match(cache, /current\.generation === generation/);
  assert.match(cache, /entry\?\.status === "success" \|\| entry\?\.status === "refreshing"/);
  assert.match(practice, /if \(initialAttempt\.assignment_id\) \{[\s\S]*invalidate\(STUDENT_WRITING_OVERVIEW_CACHE_KEY\)/);
});

test("student day details are database-bounded before attempt and review hydration", () => {
  const route = source("app/api/writing/assignments/day/route.ts");
  const details = source("lib/studentWritingAssignments.server.ts");
  assert.match(route, /\.gte\("assigned_at", range\.startInclusive\)/);
  assert.match(route, /\.lt\("assigned_at", range\.endExclusive\)/);
  assert.match(route, /\.eq\("writing_assignments\.status", "active"\)/);
  assert.match(route, /\.is\("writing_assignments\.deleted_at", null\)/);
  assert.match(details, /\.in\("assignment_id", assignmentIds\)/);
  assert.match(details, /from\("writing_attempts"\)/);
  assert.match(details, /writing_reviews\(status,published_at\)/);
  assert.match(details, /assignment_day_attempts_and_reviews/);
  assert.doesNotMatch(route, /readAllSupabaseRows/);
  assert.doesNotMatch(details, /response_text|question_snapshot,/);
  assert.match(source("supabase/student_assignment_calendar_index.sql"), /student_id, assigned_at, assignment_id/);
});

test("student and teacher multi-question pages reuse existing writing and review entry points", () => {
  const studentUi = source("components/student/StudentWritingAssignments.tsx");
  const teacherUi = source("components/teacher/TeacherWritingAssignmentDetailBody.tsx");
  const teacherRoute = source("app/api/teacher/writing/assignments/batches/[batchId]/route.ts");
  assert.match(studentUi, /loadStudentWritingAssignmentBatch/);
  assert.match(studentUi, /<StudentWritingAssignmentCard/);
  assert.match(studentUi, /<WritingPractice/);
  assert.match(teacherUi, /teacherAssignmentItemAction/);
  assert.match(teacherUi, /StudentWritingReviewAction/);
  assert.match(teacherUi, /等待提交/);
  // The review workspace href is built by the one shared item action helper.
  assert.match(
    source("lib/teacherAssignmentItems.ts"),
    /teacherWritingReviewWorkspaceHref\(review\.attemptId, input\.returnTo\)/
  );
  assert.match(teacherRoute, /from\("writing_attempts"\)/);
  assert.match(teacherRoute, /from\("writing_reviews"\)/);
  assert.doesNotMatch(teacherRoute, /\.(?:insert|update|delete)\(/i);
});

test("teacher assignment APIs count published reviews and keep the item time boundary", () => {
  const listRoute = source("app/api/teacher/writing/assignments/route.ts");
  const detailRoute = source("app/api/teacher/writing/assignments/[assignmentId]/route.ts");
  const batchRoute = source("app/api/teacher/writing/assignments/batches/[batchId]/route.ts");
  const listUi = source("components/teacher/TeacherWritingAssignmentList.tsx");
  const detailUi = source("components/teacher/TeacherWritingAssignmentDetailBody.tsx");
  assert.match(listRoute, /from\("writing_reviews"\)/);
  assert.match(listRoute, /review\.status === "published" && review\.published_at/);
  assert.match(listRoute, /published_count/);
  assert.match(listRoute, /isTeacherAssignmentStudentCompleted/);
  assert.match(detailRoute, /from\("writing_reviews"\)/);
  assert.match(detailRoute, /review\.status === "published" && review\.published_at/);
  assert.match(detailRoute, /isTeacherAssignmentStudentCompleted/);
  // Every read-only lookup carries the membership's own assigned_at boundary.
  assert.match(detailRoute, /boundaryAt: member\.assigned_at/);
  assert.match(batchRoute, /boundaryAt: member\.assigned_at/);
  assert.match(listRoute, /boundaryAt: member\.assigned_at/);
  assert.match(listUi, /AssignmentStatusBadge/);
  assert.match(detailUi, /AssignmentStatusBadge/);
  assert.doesNotMatch(listUi, /人已提交|人已发布|篇待批改/);
  assert.doesNotMatch(detailUi, /人已提交|人已发布|篇待批改/);
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

// ---------------------------------------------------------------------------
// Assignment reception for every item type (BAS / CTW / RDL / RAP / Full Set)
// ---------------------------------------------------------------------------

test("student assignment dispatcher reuses each item type's canonical practice route", () => {
  // WE / AD keep the existing Assignment entry so the attempt stays linked.
  assert.equal(
    studentAssignmentPracticeHref({ assignmentId: "assignment-1", itemId: "EMAIL-1", taskType: "email" }),
    "/student/assignments/assignment-1"
  );
  assert.equal(
    studentAssignmentPracticeHref({ assignmentId: "assignment-2", itemId: "AD-1", taskType: "academic_discussion" }),
    "/student/assignments/assignment-2"
  );
  // Without an assignment context they fall back to the catalog practice route.
  assert.equal(
    studentAssignmentPracticeHref({ itemId: "AD-1", taskType: "academic_discussion" }),
    "/student/academic-discussion/practice/AD-1"
  );
  // BAS uses practice_items.item_id for identity, but the existing practice
  // session route is keyed by the raw source set id from the snapshot.
  assert.equal(
    studentAssignmentPracticeHref({
      itemId: "practice-item-1",
      sourceSetId: "202608-0818-1",
      taskType: "build_sentence"
    }),
    "/student/practice/202608-0818-1"
  );
  for (const taskType of ["ctw", "rdl", "rap"]) {
    assert.equal(
      studentAssignmentPracticeHref({ itemId: `reading-${taskType}-item`, taskType }),
      `/student/reading/practice/reading-${taskType}-item`,
      taskType
    );
  }
  assert.equal(
    studentAssignmentPracticeHref({ itemId: "20260901A", taskType: "full_set" }),
    "/student/reading/full-sets/20260901A"
  );
  // A missing identity never invents a route.
  assert.equal(
    studentAssignmentPracticeHref({ itemId: "", sourceSetId: null, taskType: "build_sentence" }),
    null
  );
  assert.equal(
    studentAssignmentPracticeHref({ itemId: null, taskType: "ctw" }),
    null
  );
});

test("student assignment results reuse the existing result routes of each item type", () => {
  assert.equal(
    studentAssignmentResultHref({ attemptId: "attempt-1", itemId: "set-1", taskType: "build_sentence" }),
    "/student/results/attempt-1"
  );
  assert.equal(
    studentAssignmentResultHref({ attemptId: "attempt-2", itemId: "reading-rdl-item", taskType: "rdl" }),
    "/student/reading/results/attempt-2"
  );
  assert.equal(
    studentAssignmentResultHref({ attemptId: "attempt-3", itemId: "20260901A", taskType: "full_set" }),
    "/student/reading/full-sets/20260901A/result/attempt-3"
  );
  // WE / AD keep their historical submission / published-review chain.
  assert.equal(
    studentAssignmentResultHref({ attemptId: "attempt-4", itemId: "EMAIL-1", taskType: "email" }),
    null
  );
  assert.equal(studentAssignmentResultHref({ attemptId: null, taskType: "ctw" }), null);
});

test("read-only assignment items complete through their own practice result", () => {
  const readOnlyBase = {
    draft_attempt_id: null,
    due_at: null,
    latest_submitted_attempt_id: null,
    published_review_attempt_id: null
  };
  assert.equal(
    isStudentAssignmentItemCompleted({
      task_type: "rdl",
      latest_result_attempt_id: "reading-attempt-1",
      published_review_attempt_id: null
    }),
    true
  );
  assert.equal(
    isStudentAssignmentItemCompleted({
      task_type: "email",
      latest_result_attempt_id: null,
      published_review_attempt_id: null
    }),
    false
  );
  assert.equal(
    isStudentAssignmentItemCompleted({
      task_type: "email",
      latest_result_attempt_id: null,
      published_review_attempt_id: "attempt-1"
    }),
    true
  );
  assert.equal(
    getStudentWritingAssignmentDisplayStatus({ ...readOnlyBase, latest_result_attempt_id: "ra-1" }),
    "completed"
  );
  assert.equal(
    getStudentWritingAssignmentDisplayStatus({ ...readOnlyBase, has_started_result: true }),
    "in_progress"
  );
  assert.equal(getStudentWritingAssignmentDisplayStatus(readOnlyBase), "not_started");
  assert.equal(hasStudentAssignmentItemStarted({ draft_attempt_id: null, has_started_result: true }), true);
  assert.equal(hasStudentAssignmentItemStarted({ draft_attempt_id: "draft-1", has_started_result: false }), true);
  assert.equal(hasStudentAssignmentItemStarted({ draft_attempt_id: null, has_started_result: false }), false);
});

test("a mixed assignment group only completes when every item is completed", () => {
  const writingMixed = [
    {
      task_type: "email",
      draft_attempt_id: null,
      due_at: null,
      latest_submitted_attempt_id: "attempt-1",
      published_review_attempt_id: "attempt-1"
    },
    {
      task_type: "academic_discussion",
      draft_attempt_id: null,
      due_at: null,
      latest_submitted_attempt_id: "attempt-2",
      published_review_attempt_id: null
    },
    {
      task_type: "build_sentence",
      draft_attempt_id: null,
      due_at: null,
      latest_submitted_attempt_id: null,
      published_review_attempt_id: null,
      latest_result_attempt_id: null,
      has_started_result: false
    }
  ];
  // One published WE only makes the WE + AD + BAS group 进行中; a submitted but
  // unpublished AD never counts, so the group is never 已完成.
  assert.equal(studentAssignmentGroupDisplayStatus(writingMixed), "in_progress");
  assert.equal(
    studentAssignmentGroupProgress(writingMixed).group.progressText,
    "1 / 3 已完成"
  );
  const nothingCompleted = [
    writingMixed[1],
    { ...writingMixed[2], latest_result_attempt_id: null }
  ];
  assert.equal(studentAssignmentGroupDisplayStatus(nothingCompleted), "not_started");
  assert.equal(
    studentAssignmentGroupProgress(nothingCompleted).group.progressText,
    "0 / 2 已完成"
  );
  const completedBas = { ...writingMixed[2], latest_result_attempt_id: "bas-attempt-1" };
  // 1 / 3 completed stays 进行中 even though two items were submitted.
  assert.equal(studentAssignmentGroupDisplayStatus([writingMixed[0], writingMixed[1], completedBas]), "in_progress");
  const completedAd = { ...writingMixed[1], published_review_attempt_id: "attempt-2" };
  assert.equal(studentAssignmentGroupDisplayStatus([writingMixed[0], completedAd, completedBas]), "completed");
  // The group progress text is always `X / Y 已完成`.
  assert.equal(
    studentAssignmentGroupProgress([writingMixed[0], completedAd, completedBas]).group.progressText,
    "3 / 3 已完成"
  );
  assert.equal(
    studentAssignmentGroupProgress([writingMixed[0], writingMixed[1], completedBas]).group.progressText,
    "2 / 3 已完成"
  );

  const readingMixed = [
    { task_type: "ctw", draft_attempt_id: null, due_at: null, latest_submitted_attempt_id: null, published_review_attempt_id: null, latest_result_attempt_id: "ra-1" },
    { task_type: "rdl", draft_attempt_id: null, due_at: null, latest_submitted_attempt_id: null, published_review_attempt_id: null, latest_result_attempt_id: null, has_started_result: true },
    { task_type: "rap", draft_attempt_id: null, due_at: null, latest_submitted_attempt_id: null, published_review_attempt_id: null, latest_result_attempt_id: null },
    { task_type: "full_set", draft_attempt_id: null, due_at: null, latest_submitted_attempt_id: null, published_review_attempt_id: null, latest_result_attempt_id: null }
  ];
  // A completed CTW never completes the CTW + RDL + RAP + Full Set group.
  assert.equal(studentAssignmentGroupDisplayStatus(readingMixed), "in_progress");
  assert.equal(
    studentAssignmentGroupProgress(readingMixed).group.progressText,
    "1 / 4 已完成"
  );
  const readingProgress = studentAssignmentItemProgress(readingMixed);
  assert.equal(readingProgress.completedCount, 1);
  assert.equal(readingProgress.totalCount, 4);
  assert.equal(readingProgress.reviewBased, false);
  const writingProgress = studentAssignmentItemProgress(writingMixed);
  assert.equal(writingProgress.reviewBased, true);
  // A completed read-only item never counts as a published writing review.
  assert.equal(writingProgress.publishedCount, 1);
  assert.equal(
    studentAssignmentItemProgress([writingMixed[0], completedBas]).publishedCount,
    1
  );
});

test("student assignment details resolve every item identity with batched completion reads", () => {
  const details = source("lib/studentWritingAssignments.server.ts");
  const locator = source("lib/assignmentResults.server.ts");
  // The stable item identity is read from the row plus the snapshot aliases.
  assert.match(details, /question_id:question_snapshot->>question_id/);
  assert.match(details, /snapshot_item_id:question_snapshot->>item_id/);
  assert.match(details, /snapshot_source_set_id:question_snapshot->>source_set_id/);
  assert.match(details, /question_id: resolvedAssignmentItemId\(assignment\)/);
  assert.match(details, /source_set_id: assignment\.snapshot_source_set_id/);
  // One shared batched locator call for every read-only item, with the
  // membership's own assigned_at as the per-Assignment time boundary.
  assert.match(details, /loadAssignmentStudentResults\(\{/);
  assert.match(details, /boundaryAt: membership\.assigned_at/);
  assert.match(details, /studentId: input\.userId/);
  assert.equal((details.match(/loadAssignmentStudentResults\(/g) ?? []).length, 1);
  assert.match(details, /latest_result_attempt_id: itemResult\?\.available_result/);
  // The locator applies the boundary in memory instead of querying per item.
  assert.match(locator, /isInsideAssignmentWindow/);
  assert.match(locator, /boundaryAt/);
  assert.match(locator, /created_at/);
  assert.doesNotMatch(locator, /\.eq\("logical_item_id"/);
  // BAS keeps its set id for the teacher page and exposes its attempt id.
  assert.match(locator, /attempt_id: latest\.attemptId/);
});

test("student assignment entry returns the published item identity for every item type", () => {
  const entry = source("app/api/writing/assignments/entry/route.ts");
  assert.match(entry, /snapshot_source_set_id:question_snapshot->>source_set_id/);
  assert.match(entry, /resolvedAssignmentItemId\(assignment\)/);
  assert.match(entry, /source_set_id: assignment\.snapshot_source_set_id/);
  assert.match(entry, /task_type: assignment\.task_type/);
});

test("student assignment cards dispatch new item types without touching writing review", () => {
  const ui = source("components/student/StudentWritingAssignments.tsx");
  assert.match(ui, /studentAssignmentPracticeHref\(\{/);
  assert.match(ui, /studentAssignmentResultHref\(\{/);
  assert.match(ui, /StudentAssignmentPracticeRedirect/);
  assert.match(ui, /ReadingRetakeButton/);
  assert.match(ui, /ReadingFullSetRetakeButton/);
  assert.match(ui, /isStudentAssignmentItemCompleted/);
  assert.match(ui, /studentAssignmentGroupProgress/);
  assert.match(ui, /isWritingReviewItemType\(assignment\.task_type\)/);
  // The read-only branch never builds a Writing Review link.
  const nonReviewStart = ui.indexOf(") : (\n            <>");
  const nonReviewEnd = ui.indexOf("        </>\n      }\n      badges=", nonReviewStart);
  const nonReviewBranch = ui.slice(nonReviewStart, nonReviewEnd);
  assert.ok(nonReviewStart > 0 && nonReviewEnd > nonReviewStart);
  assert.doesNotMatch(nonReviewBranch, /writingReviewResultHref/);
  // Retention buttons use the shared action sizing (no compact mini size).
  assert.doesNotMatch(ui, /ReadingRetakeButton[\s\S]{0,160}?\bcompact\b/);
  assert.doesNotMatch(ui, /ReadingFullSetRetakeButton[\s\S]{0,160}?\bcompact\b/);
});

test("student cards and the detail header share the teacher presentation primitives", () => {
  const ui = source("components/student/StudentWritingAssignments.tsx");
  // The student list card, group card and detail header render through the same
  // shared shell the teacher list / detail use.
  assert.match(ui, /AssignmentSummaryCard/);
  assert.match(ui, /AssignmentStatusBadge/);
  assert.match(ui, /AssignmentProgressText/);
  assert.match(ui, /AssignmentMetaItem/);
  const teacherList = source("components/teacher/TeacherWritingAssignmentList.tsx");
  const teacherDetail = source("components/teacher/TeacherWritingAssignmentDetailBody.tsx");
  assert.match(teacherList, /from "@\/components\/assignments\/AssignmentPresentation"/);
  assert.match(teacherDetail, /from "@\/components\/assignments\/AssignmentPresentation"/);
  // Role-specific actions stay in the role-specific files.
  assert.match(teacherList, /teacher-button-primary/);
  assert.match(ui, /student-button-primary/);
  assert.doesNotMatch(ui, /teacher-button/);
  assert.doesNotMatch(ui, /teacherApiFetch|TeacherWritingAssignment|TeacherDataError/);
});

