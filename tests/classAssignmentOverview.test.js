const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");
const {
  loadClassAssignmentOverview,
  loadClassMemberBindingDomains
} = require("../lib/classAssignmentOverview.server.ts");

function assignment(id, groupId, taskType, options = {}) {
  return {
    assignment_id: id,
    created_at: options.createdAt ?? "2026-01-01T00:00:00Z",
    deleted_at: options.deletedAt ?? null,
    group_id: groupId,
    question_id: options.questionId ?? `${id}-item`,
    question_snapshot: { source_set_id: options.sourceSetId ?? null },
    source_set_id: options.sourceSetId ?? null,
    status: options.status ?? "active",
    task_type: taskType,
    teacher_id: options.teacherId ?? "teacher-1"
  };
}

function membership(assignmentId, studentId) {
  return {
    assignment_id: assignmentId,
    assigned_at: "2026-02-01T00:00:00Z",
    student_id: studentId
  };
}

function readingAttempt(id, studentId, itemId, correct, total, submittedAt) {
  return {
    attempt_id: id,
    correct_points: correct,
    created_at: submittedAt,
    logical_item_id: itemId,
    status: "submitted",
    student_id: studentId,
    submitted_at: submittedAt,
    total_points: total
  };
}

function basAttempt(id, studentId, setId, correct, total, submittedAt) {
  return {
    attempt_id: id,
    correct_count: correct,
    created_at: submittedAt,
    set_id: setId,
    student_id: studentId,
    submitted_at: submittedAt,
    total_questions: total
  };
}

function writingAttempt(id, assignmentId, studentId, submittedAt) {
  return {
    assignment_id: assignmentId,
    attempt_id: id,
    attempt_kind: "original",
    status: "submitted",
    submitted_at: submittedAt,
    user_id: studentId
  };
}

function review(attemptId, status, score) {
  return {
    attempt_id: attemptId,
    official_score: score,
    published_at: status === "published" ? "2026-02-20T00:00:00Z" : null,
    status
  };
}

function fixture() {
  return {
    writing_assignment_groups: [
      { class_id: "class-a", group_id: "g-read", teacher_id: "teacher-1" },
      { class_id: "class-a", group_id: "g-write", teacher_id: "teacher-1" },
      { class_id: "class-a", group_id: "g-other-teacher", teacher_id: "teacher-2" },
      { class_id: "class-b", group_id: "g-other-class", teacher_id: "teacher-1" }
    ],
    writing_assignments: [
      assignment("a-ctw-1", "g-read", "ctw", { questionId: "ctw-item-1" }),
      assignment("a-ctw-2", "g-read", "ctw", { questionId: "ctw-item-2" }),
      assignment("a-rdl-1", "g-read", "rdl", { questionId: "rdl-item-1" }),
      assignment("a-bas-1", "g-write", "build_sentence", {
        questionId: "bas-item-1",
        sourceSetId: "bas-set-1"
      }),
      assignment("a-we-1", "g-write", "email", { questionId: "email-1" }),
      assignment("a-ad-1", "g-write", "academic_discussion", { questionId: "ad-1" }),
      assignment("a-withdrawn", "g-read", "ctw", { status: "withdrawn" }),
      assignment("a-deleted", "g-read", "ctw", {
        deletedAt: "2026-01-05T00:00:00Z"
      }),
      assignment("a-other-teacher", "g-other-teacher", "email", {
        teacherId: "teacher-2"
      }),
      assignment("a-other-class", "g-other-class", "ctw")
    ],
    writing_assignment_students: [
      membership("a-ctw-1", "s1"),
      membership("a-ctw-2", "s1"),
      membership("a-rdl-1", "s1"),
      membership("a-bas-1", "s1"),
      membership("a-we-1", "s1"),
      membership("a-ad-1", "s1"),
      membership("a-ctw-1", "s2"),
      membership("a-ctw-2", "s2"),
      membership("a-rdl-1", "s2"),
      membership("a-bas-1", "s2"),
      membership("a-we-1", "s2"),
      membership("a-ad-1", "s2"),
      membership("a-ctw-1", "s3"),
      membership("a-ctw-2", "s3"),
      membership("a-rdl-1", "s3"),
      // A former member still has a historical recipient row. The current
      // class member list must not attribute it to anyone else.
      membership("a-ctw-1", "s4")
    ],
    teacher_student_bindings: [
      { domain: "reading", student_id: "s1", teacher_id: "teacher-1" },
      { domain: "writing", student_id: "s1", teacher_id: "teacher-1" },
      { domain: "reading", student_id: "s2", teacher_id: "teacher-1" },
      { domain: "reading", student_id: "s2", teacher_id: "teacher-2" },
      { domain: "reading", student_id: "s4", teacher_id: "teacher-1" }
    ],
    reading_attempts: [
      // Before the membership boundary: never completes a-ctw-1.
      readingAttempt("old-ctw", "s1", "ctw-item-1", 5, 5, "2026-01-20T00:00:00Z"),
      readingAttempt("s1-ctw-1", "s1", "ctw-item-1", 3, 5, "2026-02-10T00:00:00Z"),
      readingAttempt("s1-ctw-2", "s1", "ctw-item-2", 4, 5, "2026-02-11T00:00:00Z"),
      readingAttempt("s2-ctw-1", "s2", "ctw-item-1", 2, 5, "2026-02-10T00:00:00Z"),
      // Before the membership boundary: s2's second CTW stays incomplete.
      readingAttempt("s2-ctw-2-old", "s2", "ctw-item-2", 1, 5, "2026-01-25T00:00:00Z"),
      readingAttempt("s2-rdl-1", "s2", "rdl-item-1", 5, 5, "2026-02-12T00:00:00Z"),
      readingAttempt("s3-ctw-1", "s3", "ctw-item-1", 5, 5, "2026-02-10T00:00:00Z")
    ],
    attempts: [
      basAttempt("s1-bas", "s1", "bas-set-1", 8, 10, "2026-02-13T00:00:00Z")
    ],
    writing_attempts: [
      writingAttempt("s1-we-old", "a-we-1", "s1", "2026-02-05T00:00:00Z"),
      writingAttempt("s1-we-new", "a-we-1", "s1", "2026-02-15T00:00:00Z"),
      writingAttempt("s1-ad", "a-ad-1", "s1", "2026-02-16T00:00:00Z"),
      writingAttempt("s2-we", "a-we-1", "s2", "2026-02-14T00:00:00Z")
    ],
    writing_reviews: [
      review("s1-we-old", "published", 2),
      review("s1-we-new", "published", 5),
      review("s1-ad", "reviewing", null),
      review("s2-we", "published", 3)
    ],
    student_practice_summary: [
      { latest_practice_at: "2026-02-15T10:00:00Z", student_id: "s1" },
      { latest_practice_at: "2026-02-14T10:00:00Z", student_id: "s2" },
      { latest_practice_at: "2026-02-13T10:00:00Z", student_id: "s3" }
    ]
  };
}

function members() {
  return [
    { studentId: "s1", studentName: "S1" },
    { studentId: "s2", studentName: "S2" },
    { studentId: "s3", studentName: "S3" }
  ];
}

async function loadOverview() {
  const db = createMockSupabase(fixture());
  const overview = await loadClassAssignmentOverview({
    classId: "class-a",
    db,
    members: members(),
    teacherId: "teacher-1"
  });
  const memberDomains = await loadClassMemberBindingDomains(
    db,
    "teacher-1",
    ["s1", "s2", "s3"]
  );
  return { memberDomains, overview };
}

test("class overview includes only this teacher's effective class assignments", async () => {
  const { overview } = await loadOverview();
  assert.deepEqual(overview.columns.map((column) => column.label), [
    "BAS",
    "CTW",
    "RDL",
    "WE",
    "AD"
  ]);
  // The withdrawn, soft-deleted, other-teacher and other-class items never
  // create a column or a completion.
  assert.equal(overview.columns.some((column) => column.taskType === "full_set"), false);
  assert.deepEqual(overview.rows.map((row) => row.studentId), ["s1", "s2", "s3"]);
  assert.equal(
    overview.rows.some((row) => row.studentId === "s4"),
    false,
    "a former member's historical recipient row stays out of the current class table"
  );
  assert.deepEqual(
    overview.rows.map((row) => row.latestPracticeAt),
    ["2026-02-15T10:00:00Z", "2026-02-14T10:00:00Z", null]
  );
  assert.deepEqual(
    overview.rows.map((row) => row.assignedCount),
    [6, 3, 0]
  );
  assert.deepEqual(
    overview.rows.map((row) => row.completedCount),
    [4, 2, 0]
  );
});

test("class completion follows published reviews, assignment boundaries and deduplicates attempts", async () => {
  const { overview } = await loadOverview();
  const [s1, s2] = overview.rows;
  const column = (row, taskType) => row.cells.find((cell) => cell.taskType === taskType);

  // Reading completes through its own result; the pre-assignment attempt is
  // not inherited, and a second attempt of the same item is never counted.
  assert.equal(column(s1, "ctw").completedCount, 2);
  assert.equal(column(s1, "ctw").accuracyPercent, 70);
  assert.equal(column(s1, "rdl").completedCount, 0);
  assert.equal(column(s2, "ctw").completedCount, 1);
  assert.equal(column(s2, "rdl").completedCount, 1);
  assert.equal(column(s2, "rdl").accuracyPercent, 100);

  // WE completes only after publish and uses the latest submitted attempt's
  // published score, never an older score and never an attempt count.
  assert.equal(column(s1, "email").completedCount, 1);
  assert.equal(column(s1, "email").averageScore, 5);
  assert.equal(column(s1, "academic_discussion").completedCount, 0);
  assert.equal(column(s1, "academic_discussion").averageScore, null);
  assert.equal(column(s1, "build_sentence").completedCount, 1);
  assert.equal(column(s1, "build_sentence").accuracyPercent, 80);

  // s2 has a WE attempt and a published review but no writing binding. The
  // item is excluded entirely, not merely hidden from display.
  assert.equal(column(s2, "email").assignedCount, 0);
  assert.equal(column(s2, "email").completedCount, 0);
  assert.equal(column(s2, "email").averageScore, null);
});

test("class summary is weighted from grade detail, not student averages", async () => {
  const { overview } = await loadOverview();
  assert.ok(overview.summary);
  const summary = overview.summary;
  const column = (taskType) => summary.cells.find((cell) => cell.taskType === taskType);

  assert.equal(summary.assignedCount, 9);
  assert.equal(summary.completedCount, 6);
  assert.equal(summary.completionPercent, 67);
  assert.equal(column("ctw").assignedCount, 4);
  assert.equal(column("ctw").completedCount, 3);
  // (3 + 4 + 2) / (5 + 5 + 5) = 60%, not the average of 70% and 50%.
  assert.equal(column("ctw").accuracyPercent, 60);
  assert.equal(column("rdl").assignedCount, 2);
  assert.equal(column("rdl").completedCount, 1);
  assert.equal(column("rdl").accuracyPercent, 100);
  assert.equal(column("email").assignedCount, 1);
  assert.equal(column("email").averageScore, 5);
  assert.equal(column("build_sentence").accuracyPercent, 80);
  assert.equal(summary.latestPracticeAt, null);
});

test("Full Set keeps its completion count but exposes no invented grade", async () => {
  const db = createMockSupabase({
    student_practice_summary: [{ latest_practice_at: null, student_id: "s1" }],
    teacher_student_bindings: [
      { domain: "reading", student_id: "s1", teacher_id: "teacher-1" }
    ],
    writing_assignment_groups: [
      { class_id: "class-a", group_id: "g-fs", teacher_id: "teacher-1" }
    ],
    writing_assignments: [
      assignment("a-fs", "g-fs", "full_set", { questionId: "full-set-1" })
    ],
    writing_assignment_students: [membership("a-fs", "s1")],
    reading_full_set_attempts: [{
      attempt_id: "fs-attempt",
      completed_at: "2026-02-10T00:00:00Z",
      created_at: "2026-02-01T00:00:00Z",
      full_set_id: "full-set-1",
      status: "completed",
      student_id: "s1"
    }]
  });
  const overview = await loadClassAssignmentOverview({
    classId: "class-a",
    db,
    members: [{ studentId: "s1" }],
    teacherId: "teacher-1"
  });

  assert.deepEqual(overview.columns.map((column) => column.label), ["FS"]);
  const row = overview.rows[0];
  assert.equal(row.assignedCount, 1);
  assert.equal(row.completedCount, 1);
  assert.equal(row.cells[0].completedCount, 1);
  assert.equal(row.cells[0].accuracyPercent, null);
  assert.equal(row.cells[0].averageScore, null);
});

test("unbound members keep their row but expose no practice or subject data", async () => {
  const { memberDomains, overview } = await loadOverview();
  assert.deepEqual(Array.from(memberDomains.get("s1") ?? []), ["reading", "writing"]);
  assert.deepEqual(Array.from(memberDomains.get("s2") ?? []), ["reading"]);
  assert.equal(memberDomains.has("s3"), false);

  const s3 = overview.rows.find((row) => row.studentId === "s3");
  assert.ok(s3);
  assert.equal(s3.latestPracticeAt, null);
  assert.equal(s3.assignedCount, 0);
  assert.equal(s3.completedCount, 0);
  assert.ok(s3.cells.every((cell) => cell.assignedCount === 0));
});
