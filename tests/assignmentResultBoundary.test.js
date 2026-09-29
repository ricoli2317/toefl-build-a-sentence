const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");
const {
  assignmentStudentResult,
  loadAssignmentStudentResults
} = require("../lib/assignmentResults.server.ts");

/**
 * The historical attempt boundary (correctness):
 *
 *   Only attempts formally completed at or after the Assignment's effective
 *   time (`writing_assignment_students.assigned_at`) may satisfy it. The
 *   lookup stays one batched read per attempt table; the boundary is applied
 *   in memory per (assignment, student).
 */

const CTW_ITEM = "reading-ctw-item-1";
const RDL_ITEM = "reading-rdl-item-1";
const BAS_SET = "202607-0001";
const FULL_SET = "20260901A";

function dbWith(rows) {
  return createMockSupabase({
    attempts: rows.bas ?? [],
    reading_attempts: rows.reading ?? [],
    reading_full_set_attempts: rows.fullSet ?? []
  });
}

test("an autonomous practice attempt before the Assignment never completes it", async () => {
  const db = dbWith({
    reading: [
      {
        attempt_id: "old-1",
        created_at: "2026-09-20T10:00:00Z",
        logical_item_id: CTW_ITEM,
        status: "submitted",
        student_id: "student-1",
        submitted_at: "2026-09-20T10:30:00Z"
      }
    ]
  });
  const results = await loadAssignmentStudentResults({
    db,
    items: [
      {
        assignmentId: "a-new",
        itemId: CTW_ITEM,
        itemType: "ctw",
        boundaryAt: "2026-09-28T00:00:00Z",
        sourceSetId: null,
        studentId: "student-1"
      }
    ],
    studentIds: ["student-1"]
  });
  const result = assignmentStudentResult(results, "a-new", "student-1");
  assert.equal(result.available_result, null);
  assert.equal(result.started, false);
});

test("an attempt completed after the Assignment satisfies it and keeps its window", async () => {
  const db = dbWith({
    reading: [
      {
        attempt_id: "a1-attempt",
        created_at: "2026-09-10T10:00:00Z",
        logical_item_id: CTW_ITEM,
        status: "submitted",
        student_id: "student-1",
        submitted_at: "2026-09-10T10:30:00Z"
      },
      {
        attempt_id: "a2-attempt",
        created_at: "2026-09-25T10:00:00Z",
        logical_item_id: CTW_ITEM,
        status: "submitted",
        student_id: "student-1",
        submitted_at: "2026-09-25T10:30:00Z"
      }
    ]
  });
  const items = [
    {
      assignmentId: "a1",
      itemId: CTW_ITEM,
      itemType: "ctw",
      boundaryAt: "2026-09-01T00:00:00Z",
      sourceSetId: null,
      studentId: "student-1"
    },
    {
      assignmentId: "a2",
      itemId: CTW_ITEM,
      itemType: "ctw",
      boundaryAt: "2026-09-20T00:00:00Z",
      sourceSetId: null,
      studentId: "student-1"
    }
  ];
  const results = await loadAssignmentStudentResults({
    db,
    items,
    studentIds: ["student-1"]
  });
  // A1 only ever links to attempts after its own effective time; A2 never
  // inherits the 09-10 attempt of A1.
  assert.equal(assignmentStudentResult(results, "a1", "student-1").available_result.id, "a2-attempt");
  assert.equal(assignmentStudentResult(results, "a2", "student-1").available_result.id, "a2-attempt");
  assert.equal(assignmentStudentResult(results, "a2", "student-1").available_result.completed_at, "2026-09-25T10:30:00Z");

  const onlyOldAttempt = await loadAssignmentStudentResults({
    db: dbWith({
      reading: [
        {
          attempt_id: "a1-attempt",
          created_at: "2026-09-10T10:00:00Z",
          logical_item_id: CTW_ITEM,
          status: "submitted",
          student_id: "student-1",
          submitted_at: "2026-09-10T10:30:00Z"
        }
      ]
    }),
    items: [items[1]],
    studentIds: ["student-1"]
  });
  const a2Only = assignmentStudentResult(onlyOldAttempt, "a2", "student-1");
  assert.equal(a2Only.available_result, null);
  assert.equal(a2Only.started, false);
});

test("drafts only count as started inside their own Assignment window", async () => {
  const preAssignmentDraft = {
    attempt_id: "draft-old",
    created_at: "2026-09-20T09:00:00Z",
    logical_item_id: RDL_ITEM,
    status: "draft",
    student_id: "student-1",
    submitted_at: null
  };
  const postAssignmentDraft = {
    ...preAssignmentDraft,
    attempt_id: "draft-new",
    created_at: "2026-09-28T09:00:00Z"
  };
  const old = await loadAssignmentStudentResults({
    db: dbWith({ reading: [preAssignmentDraft] }),
    items: [{
      assignmentId: "a-new",
      itemId: RDL_ITEM,
      itemType: "rdl",
      boundaryAt: "2026-09-27T00:00:00Z",
      sourceSetId: null,
      studentId: "student-1"
    }],
    studentIds: ["student-1"]
  });
  assert.deepEqual(assignmentStudentResult(old, "a-new", "student-1"), {
    available_result: null,
    started: false
  });
  const fresh = await loadAssignmentStudentResults({
    db: dbWith({ reading: [preAssignmentDraft, postAssignmentDraft] }),
    items: [{
      assignmentId: "a-new",
      itemId: RDL_ITEM,
      itemType: "rdl",
      boundaryAt: "2026-09-27T00:00:00Z",
      sourceSetId: null,
      studentId: "student-1"
    }],
    studentIds: ["student-1"]
  });
  assert.deepEqual(assignmentStudentResult(fresh, "a-new", "student-1"), {
    available_result: null,
    started: true
  });
});

test("BAS and Full Set apply the same boundary with their own completion fields", async () => {
  const db = dbWith({
    bas: [
      {
        attempt_id: "bas-old",
        created_at: "2026-09-01T10:00:00Z",
        set_id: BAS_SET,
        student_id: "student-1",
        submitted_at: "2026-09-01T10:30:00Z"
      },
      {
        attempt_id: "bas-new",
        created_at: "2026-09-29T10:00:00Z",
        set_id: BAS_SET,
        student_id: "student-1",
        submitted_at: "2026-09-29T10:30:00Z"
      }
    ],
    fullSet: [
      {
        attempt_id: "fs-old",
        completed_at: "2026-09-02T10:30:00Z",
        created_at: "2026-09-02T10:00:00Z",
        full_set_id: FULL_SET,
        status: "completed",
        student_id: "student-1"
      },
      {
        attempt_id: "fs-draft",
        completed_at: null,
        created_at: "2026-09-30T10:00:00Z",
        full_set_id: FULL_SET,
        status: "in_progress",
        student_id: "student-1"
      }
    ]
  });
  const results = await loadAssignmentStudentResults({
    db,
    items: [
      {
        assignmentId: "bas-new-assignment",
        itemId: BAS_SET,
        itemType: "build_sentence",
        boundaryAt: "2026-09-28T00:00:00Z",
        sourceSetId: BAS_SET,
        studentId: "student-1"
      },
      {
        assignmentId: "bas-old-assignment",
        itemId: BAS_SET,
        itemType: "build_sentence",
        boundaryAt: "2026-08-01T00:00:00Z",
        sourceSetId: BAS_SET,
        studentId: "student-1"
      },
      {
        assignmentId: "fs-assignment",
        itemId: FULL_SET,
        itemType: "full_set",
        boundaryAt: "2026-09-28T00:00:00Z",
        sourceSetId: null,
        studentId: "student-1"
      }
    ],
    studentIds: ["student-1"]
  });
  // The new BAS assignment only sees the post-assignment attempt (the teacher
  // page is keyed by the raw set id, the student result by the attempt id).
  assert.deepEqual(assignmentStudentResult(results, "bas-new-assignment", "student-1"), {
    available_result: {
      attempt_id: "bas-new",
      completed_at: "2026-09-29T10:30:00Z",
      id: BAS_SET,
      kind: "bas_set"
    },
    started: true
  });
  assert.equal(
    assignmentStudentResult(results, "bas-old-assignment", "student-1").available_result.completed_at,
    "2026-09-29T10:30:00Z"
  );
  // The completed Full Set attempt is before the new Assignment; the in-progress
  // row only marks 进行中.
  assert.deepEqual(assignmentStudentResult(results, "fs-assignment", "student-1"), {
    available_result: null,
    started: true
  });
});

test("a missing boundary keeps the historical no-boundary behavior", async () => {
  const db = dbWith({
    reading: [
      {
        attempt_id: "old-1",
        created_at: "2026-09-20T10:00:00Z",
        logical_item_id: CTW_ITEM,
        status: "submitted",
        student_id: "student-1",
        submitted_at: "2026-09-20T10:30:00Z"
      }
    ]
  });
  const results = await loadAssignmentStudentResults({
    db,
    items: [{
      assignmentId: "legacy",
      itemId: CTW_ITEM,
      itemType: "ctw",
      sourceSetId: null,
      studentId: "student-1"
    }],
    studentIds: ["student-1"]
  });
  assert.equal(
    assignmentStudentResult(results, "legacy", "student-1").available_result.id,
    "old-1"
  );
});

test("one batched query per attempt table regardless of assignment count", async () => {
  const calls = [];
  const db = dbWith({
    reading: [
      {
        attempt_id: "attempt-1",
        created_at: "2026-09-20T10:00:00Z",
        logical_item_id: CTW_ITEM,
        status: "submitted",
        student_id: "student-1",
        submitted_at: "2026-09-20T10:30:00Z"
      }
    ]
  });
  const countingDb = {
    ...db,
    from(tableName) {
      if (tableName === "reading_attempts") calls.push(tableName);
      return db.from(tableName);
    }
  };
  await loadAssignmentStudentResults({
    db: countingDb,
    items: Array.from({ length: 20 }, (_, index) => ({
      assignmentId: `a-${index}`,
      itemId: CTW_ITEM,
      itemType: "ctw",
      boundaryAt: "2026-09-01T00:00:00Z",
      sourceSetId: null,
      studentId: "student-1"
    })),
    studentIds: ["student-1"]
  });
  assert.equal(calls.length, 1);
});

test("every caller hands the locator a non-null boundary (assigned_at, else created_at)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.resolve(__dirname, "..");
  const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
  const membershipless = [
    "lib/studentWritingAssignments.server.ts",
    "app/api/teacher/writing/assignments/route.ts",
    "app/api/teacher/writing/assignments/[assignmentId]/route.ts",
    "app/api/teacher/writing/assignments/batches/[batchId]/route.ts"
  ];
  for (const file of membershipless) {
    const source = read(file);
    // Production has 0 memberships without assigned_at (audited); if one ever
    // appears, it must fall back to the item's created_at, never to "no
    // boundary" (which would resurrect the historical-attempt pollution).
    assert.match(source, /boundaryAt: (?:member|membership)\.assigned_at \?\? assignment\.created_at/, file);
    assert.doesNotMatch(source, /boundaryAt: (?:member|membership)\.assigned_at(?! \?\?)/, file);
  }
});
