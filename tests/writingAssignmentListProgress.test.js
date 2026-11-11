const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");
const { getWritingAssignmentReviewAction } = require("../lib/writingAssignments.ts");

const root = path.resolve(__dirname, "..");
const routePath = path.join(root, "app/api/teacher/writing/assignments/route.ts");
const routeCode = ts.transpileModule(fs.readFileSync(routePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function attempt(id, overrides = {}) {
  return {
    assignment_id: "assignment-1",
    attempt_id: id,
    user_id: "student-1",
    attempt_kind: "original",
    status: "submitted",
    submitted_at: "2026-10-13T08:00:00Z",
    ...overrides
  };
}

function review(attemptId, overrides = {}) {
  return {
    attempt_id: attemptId,
    status: "published",
    published_at: "2026-10-13T09:00:00Z",
    ...overrides
  };
}

// Execute the actual GET handler with in-memory rows. Only authentication and
// unrelated metadata loaders are stubbed; selection, pagination and review
// status normalization run through the production route.
async function loadSummary(taskType, attempts, reviews) {
  const tables = {
    writing_assignments: [{
      assignment_id: "assignment-1", teacher_id: "teacher-1", group_id: "group-1",
      group_position: 0, task_type: taskType, question_source: "custom", question_id: null,
      set_title: "Fixture", source_set_id: null, due_at: null, status: "active",
      created_at: "2026-10-13T00:00:00Z", deleted_at: null
    }],
    writing_assignment_students: [{
      assignment_id: "assignment-1", student_id: "student-1", assigned_at: "2026-10-13T00:00:00Z"
    }],
    profiles: [{ id: "student-1", full_name: "Fixture Student", email: null }],
    writing_attempts: attempts,
    writing_reviews: reviews.map((row) => ({ ...row, "attempt.assignment_id": "assignment-1" }))
  };
  const before = structuredClone(tables);
  const mock = createMockSupabase(tables);
  const selections = [];
  const db = {
    from(table) {
      const builder = mock.from(table);
      const select = builder.select;
      builder.select = (fields, ...args) => {
        if (table === "writing_attempts") selections.push(fields.split(","));
        return select(fields, ...args);
      };
      return builder;
    }
  };
  const stubs = {
    "@/lib/writingAssignmentsServer": {
      requireWritingAssignmentTeacher: async () => ({ supabase: db, teacherId: "teacher-1" }),
      writingAssignmentJson: (body, init) => Response.json(body, init),
      chunkValues: (values) => values.length ? [values] : []
    },
    "@/lib/assignmentResults.server": {
      loadAssignmentStudentResults: () => { throw new Error("Unexpected non-writing result lookup"); }
    },
    "@/lib/historicalPracticeDisplay": { loadWritingAssignmentDisplayNames: async () => new Map() },
    "@/lib/writingAssignmentsGroupTitles.server": {
      loadWritingAssignmentGroupTitles: async () => new Map(),
      loadWritingAssignmentRecipientOrders: async () => new Map()
    },
    "@/lib/teacherClasses.server": { loadWritingAssignmentClassRefs: async () => new Map() }
  };
  const loaded = new Module(routePath, module);
  loaded.filename = routePath;
  loaded.paths = Module._nodeModulePaths(root);
  loaded.require = (name) => {
    if (Object.hasOwn(stubs, name)) return stubs[name];
    return require(name.startsWith("@/") ? path.join(root, `${name.slice(2)}.ts`) : name);
  };
  loaded._compile(routeCode, routePath);
  const response = await loaded.exports.GET(new Request("https://tps.test/api/teacher/writing/assignments"));
  assert.equal(response.status, 200);
  assert.deepEqual(tables, before, "listing must not change attempts or review statuses");
  assert.ok(selections.length > 0);
  for (const fields of selections) assert.ok(fields.includes("attempt_kind"));
  const body = await response.json();
  assert.equal(body.assignments.length, 1);
  return body.assignments[0];
}

function assertProgress(summary, id, status, completed) {
  assert.equal(summary.assigned_count, 1);
  assert.equal(summary.completed_count, completed ? 1 : 0);
  assert.equal(summary.published_count, completed ? 1 : 0);
  assert.equal(summary.single_student_latest_submitted_attempt_id, id);
  assert.equal(summary.single_student_latest_review_status, status);
  assert.equal(summary.has_attempts, true);
  assert.deepEqual(getWritingAssignmentReviewAction({
    latestSubmittedAttemptId: summary.single_student_latest_submitted_attempt_id,
    latestReviewStatus: summary.single_student_latest_review_status
  }), id ? {
    attemptId: id,
    label: status === "published" ? "查看批改" : status === "reviewing" ? "继续批改" : "批改"
  } : null);
}

for (const taskType of ["email", "academic_discussion"]) {
  test(`${taskType}: published original remains complete after a correction submission`, async () => {
    const summary = await loadSummary(taskType, [
      attempt("original"),
      attempt("correction", { attempt_kind: "correction", submitted_at: "2026-10-14T08:00:00Z" })
    ], [review("original")]);
    assertProgress(summary, "original", "published", true);
  });

  for (const status of [null, "reviewing", "published-without-timestamp"]) {
    test(`${taskType}: latest unpublished original (${status}) remains incomplete`, async () => {
      const reviews = [review("older")];
      if (status) reviews.push(review("latest", {
        status: status === "reviewing" ? "reviewing" : "published", published_at: null
      }));
      const summary = await loadSummary(taskType, [
        attempt("older"),
        attempt("latest", { submitted_at: "2026-10-14T08:00:00Z" }),
        attempt("correction", { attempt_kind: "correction", submitted_at: "2026-10-15T08:00:00Z" })
      ], reviews);
      assertProgress(summary, "latest", status ? "reviewing" : null, false);
    });
  }

  test(`${taskType}: multiple originals use submission time, not row order`, async () => {
    const summary = await loadSummary(taskType, [
      attempt("latest", { submitted_at: "2026-10-14T08:00:00Z" }),
      attempt("older"),
      attempt("draft", { status: "draft", submitted_at: null }),
      attempt("correction", { attempt_kind: "correction", submitted_at: "2026-10-15T08:00:00Z" })
    ], [review("latest"), review("older", { status: "reviewing", published_at: null })]);
    assertProgress(summary, "latest", "published", true);
  });

  test(`${taskType}: tied original submission times retain the attempt-id tiebreaker`, async () => {
    const summary = await loadSummary(taskType, [attempt("original-z"), attempt("original-a")], [
      review("original-z"), review("original-a", { status: "reviewing", published_at: null })
    ]);
    assertProgress(summary, "original-z", "published", true);
  });

  test(`${taskType}: historical NULL original remains compatible after correction`, async () => {
    const summary = await loadSummary(taskType, [
      attempt("legacy", { attempt_kind: null, submitted_at: "2026-10-14T08:00:00Z" }),
      attempt("older"),
      attempt("correction", { attempt_kind: "correction", submitted_at: "2026-10-15T08:00:00Z" })
    ], [review("legacy")]);
    assertProgress(summary, "legacy", "published", true);
  });

  test(`${taskType}: an assignment without corrections keeps published progress`, async () => {
    const summary = await loadSummary(taskType, [attempt("original")], [review("original")]);
    assertProgress(summary, "original", "published", true);
  });

  test(`${taskType}: correction alone never supplies ordinary progress or a review action`, async () => {
    const summary = await loadSummary(taskType, [attempt("correction", { attempt_kind: "correction" })], []);
    assertProgress(summary, null, null, false);
  });
}
