import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canManageStudent } from "../lib/accountAccess.ts";
import {
  PASSWORD_RESET_INITIAL_PASSWORD,
  createPasswordResetRequestByAccount,
  isPasswordResetTableMissing,
  readPendingPasswordResetRequestIds,
  resolvePasswordResetRequest,
  upsertPendingPasswordResetRequest
} from "../lib/passwordResetRequests.server.ts";
import { createMockSupabase } from "./fixtures/mockSupabase.js";

function createDb(tables, options = {}) {
  const db = createMockSupabase(tables);
  const authCalls = [];
  db.auth = {
    admin: {
      updateUserById: async (userId, attributes) => {
        authCalls.push({ userId, attributes });
        if (options.updateUserById) return options.updateUserById(userId, attributes);
        return { data: { user: { id: userId } }, error: null };
      }
    }
  };
  return { db, authCalls, tables };
}

const baseProfiles = [
  { id: "student-1", email: "student1@bas.com", role: "student", is_active: true },
  { id: "student-2", email: "student2@bas.com", role: "student", is_active: true },
  { id: "student-off", email: "off@bas.com", role: "student", is_active: false },
  { id: "teacher-1", email: "teacher1@bas.com", role: "teacher", is_active: true },
  { id: "teacher-2", email: "teacher2@bas.com", role: "teacher", is_active: true },
  { id: "admin-1", email: "student@test.com", role: "admin", is_active: true }
];

function baseTables() {
  return {
    profiles: baseProfiles.map((profile) => ({ ...profile })),
    password_reset_requests: [],
    teacher_student_bindings: [
      { binding_id: "b1", teacher_id: "teacher-1", student_id: "student-1", domain: "reading" },
      { binding_id: "b2", teacher_id: "teacher-2", student_id: "student-1", domain: "writing" }
    ]
  };
}

test("create request: student account creates one pending row with the profile role", async () => {
  const { db, tables } = createDb(baseTables());
  const result = await createPasswordResetRequestByAccount(db, "student1");
  assert.deepEqual(result, { ok: true });

  assert.equal(tables.password_reset_requests.length, 1);
  const row = tables.password_reset_requests[0];
  assert.equal(row.user_id, "student-1");
  assert.equal(row.account_role, "student");
  assert.equal(row.status, "pending");
  assert.ok(row.requested_at);
  assert.equal(row.resolved_at ?? null, null);
});

test("create request: unknown account is rejected without creating a row", async () => {
  const { db, tables } = createDb(baseTables());
  const result = await createPasswordResetRequestByAccount(db, "nobody");
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(tables.password_reset_requests.length, 0);
});

test("create request: admin account cannot use the forgot-password flow", async () => {
  const { db, tables } = createDb(baseTables());
  const result = await createPasswordResetRequestByAccount(db, "admin");
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(tables.password_reset_requests.length, 0);
});

test("create request: disabled account is rejected", async () => {
  const { db, tables } = createDb(baseTables());
  const result = await createPasswordResetRequestByAccount(db, "off");
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(tables.password_reset_requests.length, 0);
});

test("create request: three repeated requests keep a single refreshed pending row", async () => {
  const { db, tables } = createDb(baseTables());
  await createPasswordResetRequestByAccount(db, "student1");
  const first = tables.password_reset_requests[0];
  first.requested_at = "2020-01-01T00:00:00.000Z";

  await createPasswordResetRequestByAccount(db, "student1");
  await createPasswordResetRequestByAccount(db, "student1");

  assert.equal(tables.password_reset_requests.length, 1);
  const row = tables.password_reset_requests[0];
  assert.equal(row.request_id, first.request_id);
  assert.notEqual(row.requested_at, "2020-01-01T00:00:00.000Z");
  assert.equal(row.status, "pending");
});

test("create request: teacher account creates a teacher-role request", async () => {
  const { db, tables } = createDb(baseTables());
  const result = await createPasswordResetRequestByAccount(db, "teacher1");
  assert.deepEqual(result, { ok: true });
  assert.equal(tables.password_reset_requests[0].account_role, "teacher");
});

test("resolve approve: bound teacher globally approves and the Auth password becomes 123456", async () => {
  const { db, authCalls, tables } = createDb(baseTables());
  await upsertPendingPasswordResetRequest(db, { userId: "student-1", role: "student" });
  const request = tables.password_reset_requests[0];

  const outcome = await resolvePasswordResetRequest(db, {
    requestId: request.request_id,
    decision: "approve",
    resolverId: "teacher-1",
    targetRole: "student",
    authorize: (row) => canManageStudent(db, { userId: "teacher-1", role: "teacher" }, row.user_id)
  });

  assert.deepEqual(outcome, { ok: true, status: "approved" });
  assert.equal(request.status, "approved");
  assert.equal(request.resolved_by, "teacher-1");
  assert.ok(request.resolved_at);
  assert.equal(authCalls.length, 1);
  assert.equal(authCalls[0].userId, "student-1");
  assert.equal(authCalls[0].attributes.password, PASSWORD_RESET_INITIAL_PASSWORD);
  assert.equal(PASSWORD_RESET_INITIAL_PASSWORD, "123456");
});

test("resolve approve: a second teacher cannot re-resolve the already approved request", async () => {
  const { db, authCalls, tables } = createDb(baseTables());
  await upsertPendingPasswordResetRequest(db, { userId: "student-1", role: "student" });
  const request = tables.password_reset_requests[0];
  const authorize = (row) =>
    canManageStudent(db, { userId: "teacher-2", role: "teacher" }, row.user_id);

  const first = await resolvePasswordResetRequest(db, {
    requestId: request.request_id,
    decision: "approve",
    resolverId: "teacher-1",
    targetRole: "student",
    authorize: (row) => canManageStudent(db, { userId: "teacher-1", role: "teacher" }, row.user_id)
  });
  assert.equal(first.ok, true);

  const second = await resolvePasswordResetRequest(db, {
    requestId: request.request_id,
    decision: "reject",
    resolverId: "teacher-2",
    targetRole: "student",
    authorize
  });
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.equal(request.status, "approved", "the reject must never overwrite the approval");
  assert.equal(authCalls.length, 1, "only the winning approval may reset the password");
});

test("resolve reject: bound teacher rejects globally without touching the password", async () => {
  const { db, authCalls, tables } = createDb(baseTables());
  await upsertPendingPasswordResetRequest(db, { userId: "student-1", role: "student" });
  const request = tables.password_reset_requests[0];

  const outcome = await resolvePasswordResetRequest(db, {
    requestId: request.request_id,
    decision: "reject",
    resolverId: "teacher-2",
    targetRole: "student",
    authorize: (row) => canManageStudent(db, { userId: "teacher-2", role: "teacher" }, row.user_id)
  });

  assert.deepEqual(outcome, { ok: true, status: "rejected" });
  assert.equal(request.status, "rejected");
  assert.equal(request.resolved_by, "teacher-2");
  assert.equal(authCalls.length, 0);
});

test("resolve: a teacher without a live binding is forbidden and nothing changes", async () => {
  const { db, authCalls, tables } = createDb(baseTables());
  await upsertPendingPasswordResetRequest(db, { userId: "student-2", role: "student" });
  const request = tables.password_reset_requests[0];

  const outcome = await resolvePasswordResetRequest(db, {
    requestId: request.request_id,
    decision: "approve",
    resolverId: "teacher-1",
    targetRole: "student",
    authorize: (row) => canManageStudent(db, { userId: "teacher-1", role: "teacher" }, row.user_id)
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 403);
  assert.equal(request.status, "pending");
  assert.equal(authCalls.length, 0);
});

test("resolve: teacher API cannot resolve a teacher-role request", async () => {
  const { db, authCalls, tables } = createDb(baseTables());
  await upsertPendingPasswordResetRequest(db, { userId: "teacher-1", role: "teacher" });
  const request = tables.password_reset_requests[0];

  const outcome = await resolvePasswordResetRequest(db, {
    requestId: request.request_id,
    decision: "approve",
    resolverId: "teacher-2",
    targetRole: "student",
    authorize: async () => true
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 403);
  assert.equal(request.status, "pending");
  assert.equal(authCalls.length, 0);
});

test("resolve: Admin resolves a teacher-role request", async () => {
  const { db, authCalls, tables } = createDb(baseTables());
  await upsertPendingPasswordResetRequest(db, { userId: "teacher-1", role: "teacher" });
  const request = tables.password_reset_requests[0];

  const outcome = await resolvePasswordResetRequest(db, {
    requestId: request.request_id,
    decision: "approve",
    resolverId: "admin-1",
    targetRole: "teacher",
    authorize: async () => true
  });

  assert.deepEqual(outcome, { ok: true, status: "approved" });
  assert.equal(authCalls[0].userId, "teacher-1");
});

test("resolve approve: an Auth reset failure rolls the request back to pending", async () => {
  const { db, authCalls, tables } = createDb(baseTables(), {
    updateUserById: async () => ({ data: { user: null }, error: { message: "boom" } })
  });
  await upsertPendingPasswordResetRequest(db, { userId: "student-1", role: "student" });
  const request = tables.password_reset_requests[0];

  const outcome = await resolvePasswordResetRequest(db, {
    requestId: request.request_id,
    decision: "approve",
    resolverId: "teacher-1",
    targetRole: "student",
    authorize: async () => true
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 500);
  assert.equal(request.status, "pending", "no false success state may remain");
  assert.equal(request.resolved_at ?? null, null);
  assert.equal(authCalls.length, 1);
});

test("resolve reject: a second teacher cannot approve after the first rejection", async () => {
  const { db, authCalls, tables } = createDb(baseTables());
  await upsertPendingPasswordResetRequest(db, { userId: "student-1", role: "student" });
  const request = tables.password_reset_requests[0];

  const first = await resolvePasswordResetRequest(db, {
    requestId: request.request_id,
    decision: "reject",
    resolverId: "teacher-1",
    targetRole: "student",
    authorize: async () => true
  });
  assert.deepEqual(first, { ok: true, status: "rejected" });

  const second = await resolvePasswordResetRequest(db, {
    requestId: request.request_id,
    decision: "approve",
    resolverId: "teacher-2",
    targetRole: "student",
    authorize: async () => true
  });
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.equal(request.status, "rejected", "the approval must never overwrite the rejection");
  assert.equal(authCalls.length, 0, "a rejected request must never reset the password");
});

test("resolve: unknown request id returns not found", async () => {
  const { db, tables } = createDb(baseTables());
  const outcome = await resolvePasswordResetRequest(db, {
    requestId: "missing",
    decision: "approve",
    resolverId: "teacher-1",
    targetRole: "student",
    authorize: async () => true
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, 404);
});

test("pending lookup: a missing migration degrades to no requests and real errors still throw", async () => {
  const missingDb = {
    from() {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        then: (resolve) =>
          Promise.resolve({
            data: null,
            error: {
              code: "PGRST205",
              message: "Could not find the table 'public.password_reset_requests' in the schema cache"
            }
          }).then(resolve)
      };
      return builder;
    }
  };
  const missing = await readPendingPasswordResetRequestIds(missingDb, {
    userIds: ["student-1"],
    role: "student"
  });
  assert.equal(missing.size, 0);
  assert.equal(isPasswordResetTableMissing({ code: "PGRST205", message: "x" }), true);
  assert.equal(isPasswordResetTableMissing({ code: "42P01", message: "x" }), true);
  assert.equal(isPasswordResetTableMissing({ code: "500", message: "connection reset" }), false);

  const failingDb = {
    from() {
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        then: (resolve) =>
          Promise.resolve({ data: null, error: { code: "500", message: "connection reset" } }).then(resolve)
      };
      return builder;
    }
  };
  await assert.rejects(
    readPendingPasswordResetRequestIds(failingDb, { userIds: ["student-1"], role: "student" }),
    /connection reset/
  );
});

test("pending lookup: pending requests are keyed by user for the requested role", async () => {
  const tables = baseTables();
  tables.password_reset_requests.push(
    { request_id: "req-s1", user_id: "student-1", account_role: "student", status: "pending" },
    { request_id: "req-t1", user_id: "teacher-1", account_role: "teacher", status: "pending" },
    { request_id: "req-old", user_id: "student-2", account_role: "student", status: "approved" }
  );
  const { db } = createDb(tables);
  const studentPending = await readPendingPasswordResetRequestIds(db, {
    userIds: ["student-1", "student-2", "teacher-1"],
    role: "student"
  });
  assert.deepEqual(Array.from(studentPending.entries()), [["student-1", "req-s1"]]);

  const teacherPending = await readPendingPasswordResetRequestIds(db, {
    userIds: ["student-1", "student-2", "teacher-1"],
    role: "teacher"
  });
  assert.deepEqual(Array.from(teacherPending.entries()), [["teacher-1", "req-t1"]]);
});

test("migration: one pending row per user, atomic statuses, and no plaintext password", async () => {
  const sql = await readFile(new URL("../supabase/password_reset_requests.sql", import.meta.url), "utf8");
  assert.match(sql, /create unique index if not exists password_reset_requests_pending_unique/);
  assert.match(sql, /where status = 'pending'/);
  assert.match(sql, /check \(status in \('pending', 'approved', 'rejected'\)\)/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table public\.password_reset_requests from anon, authenticated/);
  assert.doesNotMatch(sql, /123456/);
  assert.doesNotMatch(sql, /\bpassword\s+(text|varchar|character)/i);

  const server = await readFile(new URL("../lib/passwordResetRequests.server.ts", import.meta.url), "utf8");
  assert.match(server, /PASSWORD_RESET_INITIAL_PASSWORD = "123456"/);
});

test("routes: teacher/admin/status endpoints keep their server-side permission gates", async () => {
  const teacherRoute = await readFile(
    new URL("../app/api/teacher/password-reset-requests/[requestId]/resolve/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(teacherRoute, /requireTeacherOnly/);
  assert.match(teacherRoute, /canManageStudent/);
  assert.match(teacherRoute, /targetRole: "student"/);

  const adminRoute = await readFile(
    new URL("../app/api/admin/password-reset-requests/[requestId]/resolve/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(adminRoute, /requireAdmin/);
  assert.match(adminRoute, /targetRole: "teacher"/);

  const statusRoute = await readFile(
    new URL("../app/api/admin/accounts/[accountId]/status/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(statusRoute, /requireAdmin/);
  assert.match(statusRoute, /setManagedAccountActive/);

  const overviewRoute = await readFile(
    new URL("../app/api/teacher/students/overview/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(overviewRoute, /readPendingPasswordResetRequestIds/);
  assert.match(overviewRoute, /role: "student"/);

  const teachersRoute = await readFile(
    new URL("../app/api/admin/teachers/route.ts", import.meta.url),
    "utf8"
  );
  assert.match(teachersRoute, /readPendingPasswordResetRequestIds/);
  assert.match(teachersRoute, /readPendingPasswordResetRequestIds[\s\S]{0,120}role: "teacher"/);
  assert.doesNotMatch(teachersRoute, /account_role", "student"/);
});
