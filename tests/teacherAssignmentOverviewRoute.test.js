const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");

const root = path.resolve(__dirname, "..");
const routePath = path.join(
  root,
  "app/api/teacher/writing/assignments/batches/[batchId]/route.ts"
);
const routeCode = ts.transpileModule(fs.readFileSync(routePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function assignment(id, position, taskType) {
  return {
    assignment_id: id,
    created_at: "2026-11-10T00:00:00Z",
    deleted_at: null,
    due_at: null,
    group_id: "group-1",
    group_position: position,
    question_id: `${taskType}-question`,
    question_snapshot: {
      professor_name: "Professor",
      professor_prompt: "Prompt",
      question_id: `${taskType}-question`,
      recipient: "Coordinator",
      scenario: "Scenario",
      set_id: `${taskType}-set`,
      set_title: `${taskType} title`,
      student_1_name: "Student One",
      student_1_response: "Response one",
      student_2_name: "Student Two",
      student_2_response: "Response two",
      subject: "Subject",
      task_instruction: "Instruction",
      year_month: "202611"
    },
    question_source: "custom",
    status: "active",
    task_type: taskType,
    teacher_id: "teacher-1",
    updated_at: "2026-11-10T00:00:00Z"
  };
}

function attempt(id, assignmentId, studentId, submittedAt) {
  return {
    assignment_id: assignmentId,
    attempt_id: id,
    attempt_kind: "original",
    status: "submitted",
    submitted_at: submittedAt,
    user_id: studentId
  };
}

function review(attemptId, status, officialScore) {
  return {
    attempt_id: attemptId,
    official_score: officialScore,
    published_at: status === "published" ? "2026-11-20T10:00:00Z" : null,
    status
  };
}

async function loadBatch() {
  const tables = {
    profiles: [
      { email: "alice@example.com", full_name: null, id: "s1" },
      { email: "bob@example.com", full_name: null, id: "s2" }
    ],
    writing_assignment_students: [
      { assigned_at: "2026-11-10T00:00:00Z", assignment_id: "a1", sort_order: 0, student_id: "s1" },
      { assigned_at: "2026-11-10T00:00:00Z", assignment_id: "a1", sort_order: 1, student_id: "s2" },
      { assigned_at: "2026-11-10T00:00:00Z", assignment_id: "a2", sort_order: 0, student_id: "s1" },
      { assigned_at: "2026-11-10T00:00:00Z", assignment_id: "a2", sort_order: 1, student_id: "s2" }
    ],
    writing_assignments: [
      assignment("a1", 0, "email"),
      assignment("a2", 1, "academic_discussion")
    ],
    writing_attempts: [
      attempt("e1-old", "a1", "s1", "2026-11-12T10:00:00Z"),
      attempt("e1-latest", "a1", "s1", "2026-11-15T10:00:00Z"),
      attempt("d1-old", "a2", "s1", "2026-11-13T10:00:00Z"),
      attempt("d1", "a2", "s1", "2026-11-16T10:00:00Z"),
      attempt("e2", "a1", "s2", "2026-11-14T10:00:00Z")
    ],
    writing_reviews: [
      review("e1-old", "published", 5),
      review("e1-latest", "published", 3),
      review("d1-old", "published", 5),
      review("d1", "reviewing", null),
      review("e2", "published", 4)
    ]
  };
  const db = createMockSupabase(tables);
  const stubs = {
    "@/lib/assignmentOverview.server": {
      loadStudentLatestPracticeAt: async () => new Map([
        ["s1", "2026-11-18T12:30:00Z"]
      ])
    },
    "@/lib/assignmentResults.server": {
      assignmentStudentResult: () => ({ available_result: null, started: false }),
      loadAssignmentStudentResults: async () => new Map()
    },
    "@/lib/assignmentCatalog.server": {
      resolveAssignmentCatalogItemIds: async () => new Map()
    },
    "@/lib/historicalPracticeDisplay": {
      loadWritingAssignmentDisplayNames: async () => new Map([
        ["a1", "Email title"],
        ["a2", "Discussion title"]
      ])
    },
    "@/lib/teacherClasses.server": {
      loadWritingAssignmentClassRefs: async () => new Map()
    },
    "@/lib/writingAssignmentsGroupTitles.server": {
      loadWritingAssignmentGroupTitles: async () => new Map([
        ["group-1", "Batch title"]
      ])
    },
    "@/lib/writingAssignmentsServer": {
      chunkValues: (values) => values.length ? [values] : [],
      prepareWritingAssignmentGroupEditMutation: () => { throw new Error("not used"); },
      requireWritingAssignmentTeacher: async () => ({ supabase: db, teacherId: "teacher-1" }),
      writingAssignmentClassErrorMessage: () => "",
      writingAssignmentJson: (body, init) => Response.json(body, init)
    }
  };
  const loaded = new Module(routePath, module);
  loaded.filename = routePath;
  loaded.paths = Module._nodeModulePaths(root);
  loaded.require = (name) => {
    if (Object.hasOwn(stubs, name)) return stubs[name];
    return require(name.startsWith("@/") ? path.join(root, `${name.slice(2)}.ts`) : name);
  };
  loaded._compile(routeCode, routePath);
  const response = await loaded.exports.GET(
    new Request("https://tps.test/api/teacher/writing/assignments/batches/group-1"),
    { params: { batchId: "group-1" } }
  );
  assert.equal(response.status, 200);
  return (await response.json()).collection;
}

test("batch overview matches per-item completion and uses the latest published review", async () => {
  const collection = await loadBatch();

  assert.deepEqual(
    collection.overview.columns.map((column) => column.taskType),
    ["email", "academic_discussion"]
  );
  assert.equal(collection.overview.rows.length, 2);

  const [alice, bob] = collection.overview.rows;
  assert.equal(alice.studentName, "alice@example.com");
  assert.equal(alice.latestPracticeAt, "2026-11-18T12:30:00Z");
  assert.equal(alice.assignedCount, 2);
  assert.equal(alice.completedCount, 1);
  assert.equal(alice.completionPercent, 50);
  assert.equal(
    alice.cells[0].averageScore,
    3,
    "the latest published submission (3) wins over the older one (5)"
  );
  assert.equal(alice.cells[1].completedCount, 0);
  assert.equal(alice.cells[1].averageScore, null);

  assert.equal(bob.latestPracticeAt, null);
  assert.equal(bob.completedCount, 1);
  assert.equal(bob.cells[0].averageScore, 4);

  assert.ok(collection.overview.summary);
  assert.equal(collection.overview.summary.studentName, "全班汇总");
  assert.equal(collection.overview.summary.latestPracticeAt, null);
  assert.equal(collection.overview.summary.completedCount, 2);
  assert.equal(collection.overview.summary.assignedCount, 4);
  assert.equal(collection.overview.summary.completionPercent, 50);
  assert.equal(collection.overview.summary.cells[0].completedCount, 2);
  assert.equal(collection.overview.summary.cells[0].averageScore, 3.5);

  // The same per-item rows power both surfaces.
  const detailCompleted = collection.assignments
    .flatMap((assignment) => assignment.students)
    .filter((student) => student.completed).length;
  assert.equal(collection.completed_count, detailCompleted);
  assert.equal(detailCompleted, 2);
  const discussion = collection.assignments.find(
    (assignment) => assignment.assignment_id === "a2"
  );
  const reviewing = discussion.students.find((student) => student.student_id === "s1");
  assert.equal(reviewing.latest_review_status, "reviewing");
  assert.equal(reviewing.completed, false);
});

test("a one-to-one batch renders one row and no summary row", async () => {
  const tables = {
    profiles: [{ email: "solo@example.com", full_name: null, id: "solo" }],
    writing_assignment_students: [{
      assigned_at: "2026-11-10T00:00:00Z",
      assignment_id: "a1",
      sort_order: 0,
      student_id: "solo"
    }],
    writing_assignments: [assignment("a1", 0, "email")],
    writing_attempts: [attempt("e1", "a1", "solo", "2026-11-15T10:00:00Z")],
    writing_reviews: [review("e1", "published", null)]
  };
  const db = createMockSupabase(tables);
  const stubs = {
    "@/lib/assignmentOverview.server": {
      loadStudentLatestPracticeAt: async () => new Map()
    },
    "@/lib/assignmentResults.server": {
      assignmentStudentResult: () => ({ available_result: null, started: false }),
      loadAssignmentStudentResults: async () => new Map()
    },
    "@/lib/assignmentCatalog.server": {
      resolveAssignmentCatalogItemIds: async () => new Map()
    },
    "@/lib/historicalPracticeDisplay": {
      loadWritingAssignmentDisplayNames: async () => new Map()
    },
    "@/lib/teacherClasses.server": {
      loadWritingAssignmentClassRefs: async () => new Map()
    },
    "@/lib/writingAssignmentsGroupTitles.server": {
      loadWritingAssignmentGroupTitles: async () => new Map()
    },
    "@/lib/writingAssignmentsServer": {
      chunkValues: (values) => values.length ? [values] : [],
      prepareWritingAssignmentGroupEditMutation: () => { throw new Error("not used"); },
      requireWritingAssignmentTeacher: async () => ({ supabase: db, teacherId: "teacher-1" }),
      writingAssignmentClassErrorMessage: () => "",
      writingAssignmentJson: (body, init) => Response.json(body, init)
    }
  };
  const loaded = new Module(routePath, module);
  loaded.filename = routePath;
  loaded.paths = Module._nodeModulePaths(root);
  loaded.require = (name) => {
    if (Object.hasOwn(stubs, name)) return stubs[name];
    return require(name.startsWith("@/") ? path.join(root, `${name.slice(2)}.ts`) : name);
  };
  loaded._compile(routeCode, routePath);
  const response = await loaded.exports.GET(
    new Request("https://tps.test/api/teacher/writing/assignments/batches/group-1"),
    { params: { batchId: "group-1" } }
  );
  assert.equal(response.status, 200);
  const collection = (await response.json()).collection;

  assert.equal(collection.overview.rows.length, 1);
  assert.equal(collection.overview.summary, null);
  assert.equal(collection.overview.rows[0].completedCount, 1);
  assert.equal(
    collection.overview.rows[0].cells[0].averageScore,
    null,
    "a published review without a score shows — instead of 0"
  );
  assert.equal(collection.overview.rows[0].latestPracticeAt, null);
});
