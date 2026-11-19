const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");
const {
  ASSIGNMENT_OVERVIEW_SUMMARY_NAME,
  assignmentOverviewGradeKind,
  buildAssignmentOverview
} = require("../lib/assignmentOverview.ts");
const {
  loadAssignmentStudentResults
} = require("../lib/assignmentResults.server.ts");

function student(id, latestPracticeAt = null) {
  return { studentId: id, studentName: id.toUpperCase(), latestPracticeAt };
}

function item(assignmentId, studentId, taskType, completed, options = {}) {
  return {
    assignmentId,
    studentId,
    taskType,
    completed,
    grade: options.grade ?? null,
    writingScore: options.writingScore ?? null
  };
}

test("overview columns follow the Assignment Group and only include its task types", () => {
  const overview = buildAssignmentOverview({
    students: [student("solo", "2026-11-18T12:00:00Z")],
    assignments: [
      { assignmentId: "a1", taskType: "email" },
      { assignmentId: "a2", taskType: "academic_discussion" },
      { assignmentId: "a3", taskType: "email" }
    ],
    items: [
      item("a1", "solo", "email", true, { writingScore: 4 }),
      item("a2", "solo", "academic_discussion", false),
      item("a3", "solo", "email", true, { writingScore: 3 })
    ]
  });

  assert.deepEqual(overview.columns.map((column) => column.taskType), [
    "email",
    "academic_discussion"
  ]);
  assert.deepEqual(overview.columns.map((column) => column.label), [
    "WE",
    "AD"
  ]);
  assert.equal(overview.rows.length, 1);
  assert.equal(overview.summary, null, "a one-to-one Assignment has no summary row");
  const row = overview.rows[0];
  assert.equal(row.studentName, "SOLO");
  assert.equal(row.latestPracticeAt, "2026-11-18T12:00:00Z");
  assert.equal(row.assignedCount, 3);
  assert.equal(row.completedCount, 2);
  assert.equal(row.completionPercent, 67);
  assert.equal(row.cells[0].completedCount, 2);
  assert.equal(row.cells[0].assignedCount, 2);
  assert.equal(row.cells[0].averageScore, 3.5);
  assert.equal(row.cells[1].completedCount, 0);
  assert.equal(row.cells[1].averageScore, null);
});

test("incomplete items never count as zero and contribute no grade", () => {
  const overview = buildAssignmentOverview({
    students: [student("s1")],
    assignments: [
      { assignmentId: "a1", taskType: "ctw" },
      { assignmentId: "a2", taskType: "ctw" },
      { assignmentId: "a3", taskType: "ctw" }
    ],
    items: [
      item("a1", "s1", "ctw", true, { grade: { correct: 3, total: 4 } }),
      item("a2", "s1", "ctw", false, { grade: { correct: 0, total: 8 } }),
      item("a3", "s1", "ctw", false)
    ]
  });

  const row = overview.rows[0];
  assert.equal(row.completedCount, 1);
  assert.equal(row.completionPercent, 33);
  assert.equal(row.cells[0].completedCount, 1);
  assert.equal(row.cells[0].assignedCount, 3);
  assert.equal(row.cells[0].accuracyPercent, 75);
});

test("summary accuracy is weighted from raw counts, not an average of student percentages", () => {
  const overview = buildAssignmentOverview({
    students: [student("a"), student("b")],
    assignments: [
      { assignmentId: "a1", taskType: "rdl" },
      { assignmentId: "b1", taskType: "rdl" }
    ],
    items: [
      item("a1", "a", "rdl", true, { grade: { correct: 1, total: 2 } }),
      item("b1", "b", "rdl", true, { grade: { correct: 100, total: 100 } })
    ]
  });

  assert.equal(overview.rows[0].cells[0].accuracyPercent, 50);
  assert.equal(overview.rows[1].cells[0].accuracyPercent, 100);
  assert.ok(overview.summary);
  assert.equal(overview.summary.studentName, ASSIGNMENT_OVERVIEW_SUMMARY_NAME);
  assert.equal(overview.summary.latestPracticeAt, null);
  assert.equal(overview.summary.completedCount, 2);
  assert.equal(overview.summary.assignedCount, 2);
  assert.equal(overview.summary.completionPercent, 100);
  assert.equal(
    overview.summary.cells[0].accuracyPercent,
    99,
    "101 / 102 rounds to 99, not (50 + 100) / 2"
  );
});

test("summary writing score is computed from every published item, not student averages", () => {
  const overview = buildAssignmentOverview({
    students: [student("a"), student("b")],
    assignments: [
      { assignmentId: "a1", taskType: "email" },
      { assignmentId: "a2", taskType: "email" },
      { assignmentId: "b1", taskType: "email" }
    ],
    items: [
      item("a1", "a", "email", true, { writingScore: 4 }),
      item("a2", "a", "email", true, { writingScore: 4 }),
      item("b1", "b", "email", true, { writingScore: 3 })
    ]
  });

  assert.equal(overview.rows[0].cells[0].averageScore, 4);
  assert.equal(overview.rows[1].cells[0].averageScore, 3);
  assert.equal(overview.summary.cells[0].averageScore, 3.7);
  assert.notEqual(
    overview.summary.cells[0].averageScore,
    3.5,
    "the summary must not average the two student averages"
  );
});

test("a completed writing item without a usable published score keeps its completion count", () => {
  const overview = buildAssignmentOverview({
    students: [student("s1")],
    assignments: [
      { assignmentId: "a1", taskType: "email" },
      { assignmentId: "a2", taskType: "academic_discussion" }
    ],
    items: [
      item("a1", "s1", "email", true, { writingScore: null }),
      item("a2", "s1", "academic_discussion", true, { writingScore: 5 })
    ]
  });

  const row = overview.rows[0];
  assert.equal(row.completedCount, 2);
  assert.equal(row.cells[0].completedCount, 1);
  assert.equal(row.cells[0].averageScore, null);
  assert.equal(row.cells[1].averageScore, 5);
});

test("a class with no completed items reports 0% and no grades", () => {
  const overview = buildAssignmentOverview({
    students: [student("a"), student("b")],
    assignments: [
      { assignmentId: "a1", taskType: "ctw" },
      { assignmentId: "a2", taskType: "build_sentence" }
    ],
    items: [
      item("a1", "a", "ctw", false),
      item("a2", "a", "build_sentence", false),
      item("a1", "b", "ctw", false),
      item("a2", "b", "build_sentence", false)
    ]
  });

  for (const row of overview.rows) {
    assert.equal(row.completedCount, 0);
    assert.equal(row.completionPercent, 0);
    for (const cell of row.cells) {
      assert.equal(cell.completedCount, 0);
      assert.equal(cell.accuracyPercent, null);
      assert.equal(cell.averageScore, null);
    }
  }
  assert.ok(overview.summary);
  assert.equal(overview.summary.completionPercent, 0);
  assert.equal(overview.summary.assignedCount, 4);
});

test("the shared locator exposes stored grading counts without changing result identity", async () => {
  const db = createMockSupabase({
    attempts: [{
      attempt_id: "bas-attempt",
      created_at: "2026-11-18T10:00:00Z",
      correct_count: 8,
      set_id: "bas-set",
      student_id: "s1",
      submitted_at: "2026-11-18T10:20:00Z",
      total_questions: 10
    }],
    bas_grammar_practice_sessions: [{
      assignment_id: "a-bas-category",
      attempt_id: "category-attempt",
      completed_at: "2026-11-18T11:00:00Z",
      correct_count: 12,
      session_id: "bas-session",
      started_at: "2026-11-18T10:40:00Z",
      status: "completed",
      student_id: "s1",
      total_questions: 15
    }],
    reading_attempts: [{
      attempt_id: "reading-attempt",
      correct_points: 3,
      created_at: "2026-11-18T09:00:00Z",
      logical_item_id: "ctw-item",
      status: "submitted",
      student_id: "s1",
      submitted_at: "2026-11-18T09:15:00Z",
      total_points: 5
    }, {
      attempt_id: "ungraded-reading-attempt",
      correct_points: null,
      created_at: "2026-11-18T08:00:00Z",
      logical_item_id: "rdl-item",
      status: "submitted",
      student_id: "s1",
      submitted_at: "2026-11-18T08:10:00Z",
      total_points: null
    }],
    reading_full_set_attempts: []
  });
  const grades = new Map();
  const results = await loadAssignmentStudentResults({
    db,
    grades,
    items: [
      {
        assignmentId: "a-bas",
        boundaryAt: null,
        itemId: "bas-item",
        itemType: "build_sentence",
        sourceSetId: "bas-set",
        studentId: "s1"
      },
      {
        assignmentId: "a-ctw",
        boundaryAt: null,
        itemId: "ctw-item",
        itemType: "ctw",
        sourceSetId: null,
        studentId: "s1"
      },
      {
        assignmentId: "a-bas-category",
        boundaryAt: null,
        itemId: "category-item",
        itemType: "bas_category",
        sourceSetId: null,
        studentId: "s1"
      },
      {
        assignmentId: "a-rdl",
        boundaryAt: null,
        itemId: "rdl-item",
        itemType: "rdl",
        sourceSetId: null,
        studentId: "s1"
      }
    ],
    studentIds: ["s1"]
  });

  assert.deepEqual(grades.get("a-bas:s1"), { correct: 8, total: 10 });
  assert.deepEqual(grades.get("a-ctw:s1"), { correct: 3, total: 5 });
  assert.deepEqual(grades.get("a-bas-category:s1"), { correct: 12, total: 15 });
  assert.equal(
    grades.has("a-rdl:s1"),
    false,
    "a result without stored counts must show — instead of 0%"
  );
  assert.equal(results.get("a-bas:s1").available_result.kind, "bas_set");
  assert.equal(
    Object.hasOwn(results.get("a-bas:s1").available_result, "grade"),
    false,
    "the existing result identity shape must stay unchanged"
  );
});

test("type columns use the shared short labels", () => {
  const overview = buildAssignmentOverview({
    students: [student("s1")],
    assignments: [
      { assignmentId: "a1", taskType: "build_sentence" },
      { assignmentId: "a2", taskType: "ctw" },
      { assignmentId: "a3", taskType: "rdl" },
      { assignmentId: "a4", taskType: "rap" },
      { assignmentId: "a5", taskType: "email" },
      { assignmentId: "a6", taskType: "academic_discussion" },
      { assignmentId: "a7", taskType: "full_set" },
      { assignmentId: "a8", taskType: "bas_category" },
      { assignmentId: "a9", taskType: "rap_category" }
    ],
    items: []
  });
  assert.deepEqual(overview.columns.map((column) => column.label), [
    "BAS",
    "CTW",
    "RDL",
    "RAP",
    "WE",
    "AD",
    "FS",
    "BAS 分类",
    "RAP 分类"
  ]);
});

test("the grade line kind follows the shared WE / AD review rule", () => {
  for (const taskType of [
    "email",
    "academic_discussion",
    "build_sentence",
    "ctw",
    "rdl",
    "rap",
    "full_set",
    "bas_category",
    "rap_category"
  ]) {
    assert.equal(
      assignmentOverviewGradeKind(taskType),
      taskType === "email" || taskType === "academic_discussion"
        ? "score"
        : "accuracy"
    );
  }
});
