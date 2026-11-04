import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import path from "node:path";
import ts from "typescript";
import { createMockSupabase } from "./fixtures/mockSupabase.js";
import { readAllSupabaseRows } from "../lib/supabasePagination.ts";
import { loadTeacherAssignmentReminders } from "../lib/teacherDashboardServer.ts";
import { loadTeacherStudentWritingPractice } from "../lib/teacherStudentPractice.server.ts";
import { publishWritingReviewModerationInvalidation } from "../lib/writingReviewModeration.ts";
import { mutateWritingCorrection, loadWritingCorrectionHistory } from "../lib/writingCorrection.server.ts";
import { writingCorrectionFixture, FIXTURE_ORIGINAL_ID } from "./fixtures/writingCorrectionFixture.ts";
import { loadAuthorizedWritingReviewSource, WritingReviewWorkspaceServerError } from "../lib/writingReviewWorkspaceServer.ts";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(import.meta.url);
const json = (data, init) => ({ data, status: init?.status ?? 200 });
const timing = { measure: (_layer, _name, f) => f(), measureSync: (_layer, _name, f) => f(), finishHeaders: (headers) => headers };
function loadTs(relative, mocks) {
  const filename = path.join(root, relative);
  const source = readFileSync(filename, "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText;
  const compiledModule = { exports: {} };
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, { URL, Request, Headers,
    Date, console, Response }, { filename })(
    (id) => id in mocks ? mocks[id] : require(id.startsWith(".") ? path.resolve(path.dirname(filename), id)
      : id.startsWith("@/") ? path.join(root, id.slice(2) + ".ts") : id), compiledModule, compiledModule.exports);
  return compiledModule.exports;
}
const attempts = () => [
  { attempt_id: "original", attempt_kind: "original", user_id: "s", task_type: "email", question_id: "q",
    status: "submitted", submitted_at: "2026-11-01T10:00:00Z", word_count: 100, elapsed_seconds: 420 },
  { attempt_id: "correction", attempt_kind: "correction", original_attempt_id: "original", user_id: "s",
    task_type: "email", question_id: "q", status: "submitted", submitted_at: "2026-11-02T10:00:00Z",
    word_count: 150, elapsed_seconds: 0 }
];

test("actual correction HTTP wrapper authenticates first and returns stable 409/503 codes", async () => {
  let allowed = false; let serviceCalls = 0; let failure = "WRITING_CORRECTION_VERSION_CONFLICT";
  const db = { rpc: async (_name, args) => {
    assert.equal(args.p_student, "authenticated-user");
    return { data: null, error: { code: "P0001", message: failure } };
  }, from: createMockSupabase({ writing_attempts: [{ ...writingCorrectionFixture('email', false),
    attempt_id: '11111111-1111-4111-8111-111111111111', user_id: 'authenticated-user' }] }).from };
  const api = loadTs("lib/writingCorrectionApi.server.ts", {
    "./writingServer": { requireWritingStudent: async () => allowed
      ? { userId: "authenticated-user" } : { error: json({ error: "Unauthorized" }, { status: 401 }) }, writingJson: json },
    "./supabase/server": { createServiceSupabase: () => { serviceCalls++; return db; } },
    "./writingCorrection.server.ts": { mutateWritingCorrection }
  });
  const request = () => new Request("https://unit.invalid/api/writing/corrections/id", {
    method: "PATCH", body: JSON.stringify({ action: "save", expectedDraftVersion: 0, responseText: "Text" })
  });
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal((await api.writingCorrectionRequest(request(), id)).status, 401);
  assert.equal(serviceCalls, 0);
  allowed = true;
  const conflict = await api.writingCorrectionRequest(request(), id);
  assert.equal(conflict.status, 409); assert.equal(conflict.data.code, failure);
  failure = "WRITING_CORRECTION_NOT_ENABLED";
  const gate = await api.writingCorrectionRequest(request(), id);
  assert.equal(gate.status, 503); assert.equal(gate.data.code, failure);
});

test("Phase 3 actual history loader uses owner + parent filters and real review statuses (filtering Mock)", async () => {
  const draft = writingCorrectionFixture("email", false);
  const rows = [
    { ...draft, status: "submitted", writing_reviews: [] },
    { ...draft, attempt_id: "reviewing", status: "submitted", writing_reviews: [{ status: "reviewing" }] },
    { ...draft, attempt_id: "published", status: "submitted", writing_reviews: { status: "published" } },
    { ...draft, attempt_id: "draft", writing_reviews: [] },
    { ...draft, attempt_id: "other-student", user_id: "other" },
    { ...draft, attempt_id: "other-original", original_attempt_id: "other" },
    { ...draft, attempt_id: FIXTURE_ORIGINAL_ID, attempt_kind: "original", original_attempt_id: null }
  ];
  const db = createMockSupabase({ writing_attempts: rows });
  const result = await loadWritingCorrectionHistory(db, draft.user_id, FIXTURE_ORIGINAL_ID);
  assert.equal(result.attempts.length, 4);
  assert.deepEqual(result.attempts.map((row) => row.reviewStatus).sort(), [null, "pending", "published", "reviewing"].sort());
  assert.ok(result.attempts.every((row) => row.original_attempt_id === FIXTURE_ORIGINAL_ID));
  assert.ok(result.attempts.every((row) => !("writing_reviews" in row)));
  await assert.rejects(loadWritingCorrectionHistory(db, "other", FIXTURE_ORIGINAL_ID), (error) => error.status === 404);
});

test("Phase 3 actual teacher correction-source API enforces scope, submitted kind, and reads frozen original only (Mock)", async () => {
  const draft = writingCorrectionFixture("email", false);
  const correction = { ...draft, status: "submitted", submitted_at: "2026-11-03T00:00:00Z", response_text: "Submitted correction text" };
  const tables = {
    writing_attempts: [correction], writing_assignments: [],
    teacher_student_bindings: [{ teacher_id: "teacher", student_id: draft.user_id, domain: "writing", student: { id: draft.user_id, role: "student", is_active: true } }],
    profiles: [{ id: draft.user_id, role: "student", is_active: true, full_name: "Student Name", email: "mock@example.invalid" }]
  };
  const db = createMockSupabase(tables);
  let actor = { userId: "teacher", role: "teacher" };
  const route = loadTs("app/api/teacher/writing/reviews/[attemptId]/correction-source/route.ts", {
    "@/lib/auth": { bearerToken: () => "test-token", requireTeacherOnly: async () => actor },
    "@/lib/supabase/server": { createServiceSupabase: () => db },
    "@/lib/writingServer": { writingJson: json },
    "@/lib/writingReviewWorkspaceServer": { assertWritingReviewTeacher: () => {}, loadAuthorizedWritingReviewSource, WritingReviewWorkspaceServerError }
  });
  const request = () => route.GET(new Request("https://unit.invalid/api/teacher/correction-source"), { params: { attemptId: draft.attempt_id } });
  let result = await request();
  assert.equal(result.status, 200);
  assert.equal(result.data.studentName, "Student Name");
  assert.equal(result.data.frozen_source.original_response_text, draft.response_text);
  assert.equal(result.data.attempt.response_text, "Submitted correction text");
  // Phase 4 enables the correction review workspace for submitted corrections.
  assert.equal(result.data.review_supported, true);
  actor = { userId: "unbound", role: "teacher" };
  assert.equal((await request()).status, 404);
  actor = { userId: "admin", role: "admin" };
  assert.equal((await request()).status, 200);
  correction.status = "draft";
  assert.equal((await request()).status, 404);
  correction.status = "submitted"; correction.attempt_kind = "original";
  assert.equal((await request()).status, 404);
});

test("actual overview route counts only original submissions and dates with a filtering mock", async () => {
  const db = createMockSupabase({ writing_attempts: attempts() });
  const route = loadTs("app/api/writing/overview/route.ts", {
    "@/lib/supabasePagination": { readAllSupabaseRows },
    "@/lib/supabase/server": { createServiceSupabase: () => db },
    "@/lib/writingServer": { requireWritingStudent: async () => ({ userId: "s", supabase: db }), writingJson: json },
    "@/lib/studentPerformance.server": { createStudentPerformanceTrace: () => timing }
  });
  const result = await route.GET(new Request("https://unit.invalid/api/writing/overview"));
  assert.equal(result.status, 200); assert.equal(result.data.submittedCount, 1);
  assert.equal(result.data.learningDates.length, 1);
});

test("ordinary GET/PATCH reject correction IDs; ordinary POST rejects protected fields before writes", async () => {
  const db = createMockSupabase({ writing_attempts: attempts() });
  const server = loadTs("lib/writingServer.ts", {
    "next/server": { NextResponse: { json } },
    "@/lib/auth": { bearerToken: () => "unit-token", requireUserWithRole: async () => ({ userId: "s" }) },
    "@/lib/supabase/server": { createAnonSupabase: () => db }
  });
  const mocks = {
    "@/lib/writingServer": server,
    "@/lib/supabase/server": { createServiceSupabase: () => db },
    "@/lib/historicalPracticeDisplay": {},
    "@/lib/studentPerformance.server": { createStudentPerformanceTrace: () => timing },
    "@/lib/writingModePolicy": {}
  };
  const route = loadTs("app/api/writing/attempts/[attemptId]/route.ts", mocks);
  const context = { params: { attemptId: "correction" } };
  assert.equal((await route.GET(new Request("https://unit.invalid/api/writing/attempts/correction"), context)).status, 404);
  assert.equal((await route.PATCH(new Request("https://unit.invalid/api/writing/attempts/correction", {
    method: "PATCH", body: JSON.stringify({ action: "submit", responseText: "overwrite" })
  }), context)).status, 404);
  const create = loadTs("app/api/writing/attempts/route.ts", mocks);
  for (const key of ["attempt_kind", "original_attempt_id", "correction_source_snapshot", "draft_version", "user_id"]) {
    const result = await create.POST(new Request("https://unit.invalid/api/writing/attempts", {
      method: "POST", body: JSON.stringify({ taskType: "email", questionId: "q", writingMode: "exam", [key]: "forged" })
    }));
    assert.equal(result.status, 400, key);
  }
});

test("actual teacher history excludes correction time and records", async () => {
  const db = createMockSupabase({ writing_attempts: attempts() });
  const result = await loadTeacherStudentWritingPractice(db, "s", "2026-11-01", "2026-11-04");
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].attemptId, "original");
});

test("actual Assignment reminder query is not completed by a correction", async () => {
  const tables = {
    writing_assignments: [{ assignment_id: "a", teacher_id: "t", status: "active", deleted_at: null, due_at: "2026-11-02T00:00:00Z" }],
    writing_assignment_students: [{ assignment_id: "a", student_id: "s" }],
    writing_attempts: [{ ...attempts()[1], assignment_id: "a" }]
  };
  const db = createMockSupabase(tables);
  const load = () => loadTeacherAssignmentReminders(db, "t", new Date("2026-11-03T00:00:00Z"), new Map([["s", "Student"]]));
  assert.equal((await load()).length, 1);
  tables.writing_attempts.push({ ...attempts()[0], assignment_id: "a" });
  assert.equal((await load()).length, 0);
});

test("actual moderation event publisher separates correction and original caches", () => {
  const windowBefore = globalThis.window; const broadcastBefore = globalThis.BroadcastChannel;
  const events = [];
  globalThis.window = { dispatchEvent: (event) => events.push(event.detail) };
  globalThis.BroadcastChannel = undefined;
  try {
    publishWritingReviewModerationInvalidation("return", [
      { attemptId: "c", studentId: "s", assignmentId: "a", attemptKind: "correction", originalAttemptId: "o" },
      { attemptId: "o", studentId: "s", assignmentId: "a", attemptKind: "original" }
    ], [{ attemptId: "c", outcome: "returned", reason: null }, { attemptId: "o", outcome: "returned", reason: null }]);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "WRITING_CORRECTION_UPDATED");
    assert.equal(events[0].attemptKind, "correction");
    assert.equal(events[1].type, "WRITING_ATTEMPT_RETURNED");
  } finally { globalThis.window = windowBefore; globalThis.BroadcastChannel = broadcastBefore; }
});
