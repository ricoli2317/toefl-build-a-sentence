import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildWritingAssignmentTransferUnits,
  loadWritingAssignmentTransferBoard,
  missingWritingBindingRecipients,
  runWritingAssignmentTransfer,
  WritingAssignmentTransferError
} from "../lib/writingAssignmentTransfer.ts";
import { canManageWritingAttempt } from "../lib/accountAccess.ts";
import { createMockSupabase } from "./fixtures/mockSupabase.js";

function createTables() {
  return {
    profiles: [
      { id: "admin-1", role: "admin", is_active: true, email: "admin@test.local", full_name: "平台管理员" },
      { id: "admin-2", role: "admin", is_active: true, email: "admin2@test.local", full_name: "第二管理员" },
      { id: "teacher-a", role: "teacher", is_active: true, email: "teachera@test.local", full_name: "Teacher A" },
      { id: "teacher-b", role: "teacher", is_active: true, email: "teacherb@test.local", full_name: "Teacher B" },
      { id: "teacher-off", role: "teacher", is_active: false, email: "teacheroff@test.local", full_name: "Inactive Teacher" },
      { id: "student-1", role: "student", is_active: true, email: "s1@test.local", full_name: "Student One" },
      { id: "student-2", role: "student", is_active: true, email: "s2@test.local", full_name: "Student Two" },
      { id: "student-3", role: "student", is_active: true, email: "s3@test.local", full_name: "Student Three" }
    ],
    teacher_student_bindings: [
      { binding_id: "bind-a1", teacher_id: "teacher-a", student_id: "student-1", domain: "writing" },
      { binding_id: "bind-a2", teacher_id: "teacher-a", student_id: "student-2", domain: "writing" },
      { binding_id: "bind-b1", teacher_id: "teacher-b", student_id: "student-1", domain: "writing" },
      { binding_id: "bind-a3-reading", teacher_id: "teacher-a", student_id: "student-3", domain: "reading" }
    ],
    writing_assignment_groups: [
      { group_id: "group-admin", teacher_id: "admin-1", created_at: "2026-01-10T00:00:00.000Z" }
    ],
    writing_assignments: [
      {
        assignment_id: "as-admin",
        teacher_id: "admin-1",
        group_id: null,
        group_position: null,
        task_type: "email",
        question_source: "custom",
        question_id: null,
        question_snapshot: { set_title: "历史邮件作业" },
        due_at: null,
        status: "active",
        deleted_at: null,
        created_at: "2026-01-05T00:00:00.000Z"
      },
      {
        assignment_id: "as-teacher",
        teacher_id: "teacher-b",
        group_id: null,
        group_position: null,
        task_type: "email",
        question_source: "custom",
        question_id: null,
        question_snapshot: { set_title: "普通教师自己的作业" },
        due_at: null,
        status: "active",
        deleted_at: null,
        created_at: "2026-01-06T00:00:00.000Z"
      },
      {
        assignment_id: "as-group-1",
        teacher_id: "admin-1",
        group_id: "group-admin",
        group_position: 1,
        task_type: "academic_discussion",
        question_source: "question_bank",
        question_id: "AD-1",
        question_snapshot: { set_title: "历史讨论组一" },
        due_at: null,
        status: "active",
        deleted_at: null,
        created_at: "2026-01-10T00:00:00.000Z"
      },
      {
        assignment_id: "as-group-2",
        teacher_id: "admin-1",
        group_id: "group-admin",
        group_position: 2,
        task_type: "academic_discussion",
        question_source: "custom",
        question_id: null,
        question_snapshot: { set_title: "历史讨论组二" },
        due_at: null,
        status: "withdrawn",
        deleted_at: null,
        created_at: "2026-01-10T00:00:01.000Z"
      }
    ],
    writing_assignment_students: [
      { assignment_id: "as-admin", student_id: "student-1" },
      { assignment_id: "as-admin", student_id: "student-2" },
      { assignment_id: "as-teacher", student_id: "student-1" },
      { assignment_id: "as-group-1", student_id: "student-1" },
      { assignment_id: "as-group-2", student_id: "student-2" }
    ],
    writing_attempts: [
      {
        attempt_id: "att-admin-1",
        assignment_id: "as-admin",
        user_id: "student-1",
        status: "submitted",
        submitted_at: "2026-01-08T00:00:00.000Z",
        response_text: "history must stay unchanged"
      },
      {
        attempt_id: "att-group-1",
        assignment_id: "as-group-1",
        user_id: "student-1",
        status: "submitted",
        submitted_at: "2026-01-11T00:00:00.000Z",
        response_text: "group history must stay unchanged"
      }
    ],
    writing_reviews: [
      {
        review_id: "rev-admin-1",
        attempt_id: "att-admin-1",
        status: "published",
        published_at: "2026-01-09T00:00:00.000Z",
        scores: { overall: 24 }
      },
      {
        review_id: "rev-group-1",
        attempt_id: "att-group-1",
        status: "reviewing",
        published_at: null,
        scores: null
      }
    ],
    writing_review_ai_logs: [
      { id: "log-admin-1", attempt_id: "att-admin-1", operation: "generate_ai", created_at: "2026-01-08T01:00:00.000Z" }
    ]
  };
}

function mockBoard(tables) {
  return createMockSupabase(tables);
}

function mockTransfer(tables, calls) {
  return createMockSupabase(tables, {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      if (fn !== "transfer_writing_assignment_ownership") {
        return { data: null, error: { message: `unexpected rpc ${fn}` } };
      }
      const assignmentIds = args.p_assignment_id
        ? tables.writing_assignments
            .filter((row) => row.assignment_id === args.p_assignment_id)
            .map((row) => row.assignment_id)
        : tables.writing_assignments
            .filter((row) => row.group_id === args.p_group_id)
            .map((row) => row.assignment_id);
      for (const row of tables.writing_assignments) {
        if (assignmentIds.includes(row.assignment_id)) {
          row.teacher_id = args.p_target_teacher_id;
        }
      }
      if (args.p_group_id) {
        const group = tables.writing_assignment_groups.find(
          (row) => row.group_id === args.p_group_id
        );
        if (group) group.teacher_id = args.p_target_teacher_id;
      }
      return {
        data: {
          group_id: args.p_group_id,
          assignment_ids: assignmentIds,
          teacher_id: args.p_target_teacher_id
        },
        error: null
      };
    }
  });
}

function snapshot(tables) {
  return structuredClone({
    writing_assignments: tables.writing_assignments,
    writing_attempts: tables.writing_attempts,
    writing_reviews: tables.writing_reviews,
    writing_review_ai_logs: tables.writing_review_ai_logs
  });
}

test("case 1: admin-owned standalone assignment transfers to a bound teacher only changing the owner", async () => {
  const tables = createTables();
  const calls = [];
  const before = snapshot(tables);

  const result = await runWritingAssignmentTransfer(mockTransfer(tables, calls), {
    unitType: "assignment",
    unitId: "as-admin",
    targetTeacherId: "teacher-a"
  });

  assert.deepEqual(result.assignmentIds, ["as-admin"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, "transfer_writing_assignment_ownership");
  assert.deepEqual(calls[0].args, {
    p_assignment_id: "as-admin",
    p_group_id: null,
    p_target_teacher_id: "teacher-a"
  });
  assert.equal(
    tables.writing_assignments.find((row) => row.assignment_id === "as-admin").teacher_id,
    "teacher-a"
  );
  assert.equal(
    tables.writing_assignments.find((row) => row.assignment_id === "as-teacher").teacher_id,
    "teacher-b"
  );
  assert.equal(tables.writing_assignment_groups[0].teacher_id, "admin-1");
  assert.deepEqual(snapshot(tables).writing_attempts, before.writing_attempts);
  assert.deepEqual(snapshot(tables).writing_reviews, before.writing_reviews);
  assert.deepEqual(snapshot(tables).writing_review_ai_logs, before.writing_review_ai_logs);
});

test("case 2: a recipient without the target teacher writing binding blocks the transfer", async () => {
  const tables = createTables();
  const calls = [];
  const before = snapshot(tables);

  await assert.rejects(
    runWritingAssignmentTransfer(mockTransfer(tables, calls), {
      unitType: "assignment",
      unitId: "as-admin",
      targetTeacherId: "teacher-b"
    }),
    (error) => {
      assert.ok(error instanceof WritingAssignmentTransferError);
      assert.equal(error.code, "MISSING_WRITING_BINDING");
      assert.equal(error.status, 409);
      assert.deepEqual(error.missingStudents.map((student) => student.displayName), ["Student Two"]);
      return true;
    }
  );

  assert.equal(calls.length, 0);
  assert.deepEqual(snapshot(tables), before);
});

test("case 3: inactive teacher target is rejected before any mutation", async () => {
  const tables = createTables();
  const calls = [];
  const before = snapshot(tables);

  await assert.rejects(
    runWritingAssignmentTransfer(mockTransfer(tables, calls), {
      unitType: "assignment",
      unitId: "as-admin",
      targetTeacherId: "teacher-off"
    }),
    (error) => {
      assert.ok(error instanceof WritingAssignmentTransferError);
      assert.equal(error.code, "INVALID_TARGET_TEACHER");
      assert.equal(error.status, 400);
      return true;
    }
  );

  assert.equal(calls.length, 0);
  assert.deepEqual(snapshot(tables), before);
});

test("case 5: grouped transfer updates the group and every child assignment atomically", async () => {
  const tables = createTables();
  const calls = [];

  const result = await runWritingAssignmentTransfer(mockTransfer(tables, calls), {
    unitType: "group",
    unitId: "group-admin",
    targetTeacherId: "teacher-a"
  });

  assert.deepEqual(result.assignmentIds.sort(), ["as-group-1", "as-group-2"]);
  assert.deepEqual(calls[0].args, {
    p_assignment_id: null,
    p_group_id: "group-admin",
    p_target_teacher_id: "teacher-a"
  });
  assert.equal(tables.writing_assignment_groups[0].teacher_id, "teacher-a");
  for (const assignmentId of ["as-group-1", "as-group-2"]) {
    assert.equal(
      tables.writing_assignments.find((row) => row.assignment_id === assignmentId).teacher_id,
      "teacher-a"
    );
  }
  assert.equal(
    tables.writing_assignments.find((row) => row.assignment_id === "as-admin").teacher_id,
    "admin-1"
  );
  assert.equal(
    tables.writing_assignments.find((row) => row.assignment_id === "as-teacher").teacher_id,
    "teacher-b"
  );
});

test("case 6: one unbound group recipient rolls the whole grouped transfer back", async () => {
  const tables = createTables();
  tables.writing_assignment_students.push({ assignment_id: "as-group-2", student_id: "student-3" });
  const calls = [];
  const before = snapshot(tables);

  await assert.rejects(
    runWritingAssignmentTransfer(mockTransfer(tables, calls), {
      unitType: "group",
      unitId: "group-admin",
      targetTeacherId: "teacher-a"
    }),
    (error) => {
      assert.ok(error instanceof WritingAssignmentTransferError);
      assert.equal(error.code, "MISSING_WRITING_BINDING");
      assert.deepEqual(error.missingStudents.map((student) => student.id), ["student-3"]);
      return true;
    }
  );

  assert.equal(calls.length, 0);
  assert.deepEqual(snapshot(tables), before);
  assert.equal(tables.writing_assignment_groups[0].teacher_id, "admin-1");
  for (const assignment of tables.writing_assignments) {
    assert.notEqual(assignment.teacher_id, "teacher-a");
  }
});

test("case 7: after transfer the target teacher owns access and other writing teachers do not", async () => {
  const tables = createTables();
  const calls = [];
  await runWritingAssignmentTransfer(mockTransfer(tables, calls), {
    unitType: "assignment",
    unitId: "as-admin",
    targetTeacherId: "teacher-a"
  });

  const db = mockBoard(tables);
  assert.equal(
    await canManageWritingAttempt(db, { userId: "teacher-a", role: "teacher" }, "att-admin-1"),
    true
  );
  assert.equal(
    await canManageWritingAttempt(db, { userId: "teacher-b", role: "teacher" }, "att-admin-1"),
    false
  );
});

test("transferred units disappear from the admin board and teacher assignments stay hidden", async () => {
  const tables = createTables();
  const calls = [];
  const board = await loadWritingAssignmentTransferBoard(mockBoard(tables));
  assert.deepEqual(
    board.units.map((unit) => unit.unitId).sort(),
    ["as-admin", "group-admin"]
  );
  assert.deepEqual(board.teachers.map((teacher) => teacher.id), ["teacher-a", "teacher-b"]);
  const standalone = board.units.find((unit) => unit.unitId === "as-admin");
  assert.equal(standalone.compatibility["teacher-a"].eligible, true);
  assert.deepEqual(
    standalone.compatibility["teacher-b"].missingStudents.map((student) => student.id),
    ["student-2"]
  );
  assert.equal(standalone.hasSubmittedAttempt, true);
  assert.equal(standalone.publishedReviewCount, 1);
  const groupUnit = board.units.find((unit) => unit.unitId === "group-admin");
  assert.equal(groupUnit.unitType, "group");
  assert.deepEqual(groupUnit.taskTypes, ["academic_discussion"]);
  assert.deepEqual(groupUnit.assignments.map((assignment) => assignment.groupPosition), [1, 2]);

  await runWritingAssignmentTransfer(mockTransfer(tables, calls), {
    unitType: "group",
    unitId: "group-admin",
    targetTeacherId: "teacher-a"
  });
  const after = await loadWritingAssignmentTransferBoard(mockBoard(tables));
  assert.deepEqual(after.units.map((unit) => unit.unitId), ["as-admin"]);
});

test("grouped assignment id cannot be transferred through the standalone path", async () => {
  const tables = createTables();
  const calls = [];
  await assert.rejects(
    runWritingAssignmentTransfer(mockTransfer(tables, calls), {
      unitType: "assignment",
      unitId: "as-group-1",
      targetTeacherId: "teacher-a"
    }),
    (error) => error.code === "TRANSFER_GROUP_REQUIRED" && error.status === 409
  );
  assert.equal(calls.length, 0);
});

test("concurrent ownership change is reported as a conflict instead of overwriting", async () => {
  const tables = createTables();
  tables.writing_assignments.find((row) => row.assignment_id === "as-admin").teacher_id = "teacher-b";
  await assert.rejects(
    runWritingAssignmentTransfer(mockBoard(tables), {
      unitType: "assignment",
      unitId: "as-admin",
      targetTeacherId: "teacher-a"
    }),
    (error) => error.code === "TRANSFER_SOURCE_NOT_ADMIN" && error.status === 409
  );
});

test("missingWritingBindingRecipients treats only same-teacher writing bindings as valid", () => {
  const recipients = [
    { id: "student-1", displayName: "Student One", email: "" },
    { id: "student-2", displayName: "Student Two", email: "" }
  ];
  const bindings = [
    { teacherId: "teacher-a", studentId: "student-1", domain: "writing" },
    { teacherId: "teacher-b", studentId: "student-2", domain: "writing" },
    { teacherId: "teacher-a", studentId: "student-2", domain: "reading" }
  ];
  assert.deepEqual(
    missingWritingBindingRecipients(recipients, "teacher-a", bindings).map((row) => row.id),
    ["student-2"]
  );
});

test("buildWritingAssignmentTransferUnits marks empty-recipient groups as eligible", () => {
  const units = buildWritingAssignmentTransferUnits({
    admins: [{ id: "admin-1", email: "admin@test.local", full_name: "平台管理员" }],
    teachers: [{ id: "teacher-a", displayName: "Teacher A", email: "a@test.local" }],
    assignments: [
      {
        assignment_id: "as-empty",
        teacher_id: "admin-1",
        group_id: null,
        group_position: null,
        task_type: "email",
        question_source: "custom",
        question_id: null,
        question_snapshot: {},
        status: "active",
        deleted_at: null,
        created_at: "2026-01-01T00:00:00.000Z"
      }
    ],
    groups: [],
    members: [],
    submittedAttempts: [],
    reviews: [],
    recipientProfiles: [],
    bindings: []
  });
  assert.equal(units.length, 1);
  assert.equal(units[0].title, "自定义题目");
  assert.equal(units[0].compatibility["teacher-a"].eligible, true);
});

test("case 8: phase 3 teacher-only boundaries remain in place for assignment and review APIs", async () => {
  const [assignmentServer, reviewsRoute, attemptRoute, aiLogsRoute] = await Promise.all([
    readFile(new URL("../lib/writingAssignmentsServer.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/teacher/writing/reviews/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/teacher/writing/reviews/[attemptId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/teacher/writing/reviews/ai-logs/route.ts", import.meta.url), "utf8")
  ]);
  assert.match(assignmentServer, /requireTeacherOnly/);
  assert.match(assignmentServer, /auth\.error === "Forbidden" \? 403 : 401/);
  assert.match(reviewsRoute, /requireTeacherOnly/);
  assert.match(reviewsRoute, /"Forbidden" \? 403 : 401/);
  assert.match(attemptRoute, /requireTeacherOnly/);
  assert.match(aiLogsRoute, /requireTeacherOnly/);
});

test("case 9: transfer SQL never mutates attempts, reviews, AI logs, or student membership", async () => {
  const sql = await readFile(
    new URL("../supabase/writing_assignment_ownership_transfer.sql", import.meta.url),
    "utf8"
  );
  assert.match(sql, /create or replace function public\.transfer_writing_assignment_ownership/);
  assert.match(sql, /security definer/);
  assert.match(sql, /target_role is distinct from 'teacher' or target_is_active is distinct from true/);
  assert.match(sql, /source_role is distinct from 'admin'/);
  assert.match(sql, /from public\.teacher_student_bindings binding[\s\S]*?binding\.domain = 'writing'/);
  assert.match(sql, /update public\.writing_assignment_groups/);
  assert.match(sql, /update public\.writing_assignments/);
  assert.doesNotMatch(sql, /update public\.writing_attempts/);
  assert.doesNotMatch(sql, /update public\.writing_reviews/);
  assert.doesNotMatch(sql, /update public\.writing_review_ai_logs/);
  assert.doesNotMatch(sql, /insert into public\.writing_assignment_students/);
  assert.doesNotMatch(sql, /delete from public\.writing_assignment_students/);
  assert.doesNotMatch(sql, /alter table public\.writing_reviews/);
  assert.match(sql, /raise exception 'TRANSFER_MISSING_WRITING_BINDING'/);
  assert.match(
    sql,
    /grant execute on function public\.transfer_writing_assignment_ownership\(uuid, uuid, uuid\)\s+to service_role/
  );
  assert.doesNotMatch(sql, /grant execute on function public\.transfer_writing_assignment_ownership[\s\S]{0,160}?to authenticated/);
});

test("case 4 + admin API: transfer endpoint requires admin and re-reads state from the database", async () => {
  const [route, lib] = await Promise.all([
    readFile(new URL("../app/api/admin/writing-assignment-transfer/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/writingAssignmentTransfer.ts", import.meta.url), "utf8")
  ]);
  assert.match(route, /requireAdmin/);
  assert.doesNotMatch(route, /requireTeacherOnly|requireUserWithRole/);
  assert.match(route, /status: 403/);
  assert.match(route, /runWritingAssignmentTransfer/);
  assert.match(route, /loadWritingAssignmentTransferBoard/);
  assert.match(lib, /\.eq\("role", "admin"\)/);
  assert.match(lib, /\.in\("teacher_id", adminIds\)/);
  assert.match(lib, /isEligibleWritingTransferTeacher/);
  assert.match(lib, /missingWritingBindingRecipients/);
  assert.match(lib, /\.rpc\("transfer_writing_assignment_ownership"/);
});

test("admin transfer UI keeps an explicit confirmation step and publishes cache invalidation", async () => {
  const component = await readFile(
    new URL("../components/admin/WritingAssignmentTransfer.tsx", import.meta.url),
    "utf8"
  );
  assert.match(component, /确认将该/);
  assert.match(component, /学生提交、批改和 AI 记录保持不变/);
  assert.match(component, /目标教师将成为该作业唯一 Owner/);
  assert.match(component, /Admin 不再通过教学工作流管理该作业/);
  assert.match(component, /publishCacheInvalidation\(\{ type: "TEACHER_BINDING_UPDATED" \}\)/);
  assert.match(component, /\/admin\/student-bindings/);
  assert.doesNotMatch(component, /window\.confirm/);
});

test("case 10: Teacher Bindings is renamed to 教师绑定 while routes, tables, and events stay unchanged", async () => {
  const [shell, dashboard, bindingsPage] = await Promise.all([
    readFile(new URL("../components/teacher/TeacherAppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/TeacherDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/student-bindings/page.tsx", import.meta.url), "utf8")
  ]);
  assert.match(shell, /label: "教师绑定"/);
  assert.doesNotMatch(shell, /Teacher Bindings/);
  assert.match(shell, /href: "\/admin\/student-bindings"/);
  assert.match(shell, /label: "历史作业转移"/);
  assert.match(shell, /href: "\/admin\/writing-assignment-transfer"/);
  assert.doesNotMatch(dashboard, /Teacher Bindings/);
  assert.match(dashboard, /title="教师绑定"/);
  assert.match(bindingsPage, /title="教师绑定"/);

  const [invalidation, bindingsRoute, transferPage] = await Promise.all([
    readFile(new URL("../lib/cacheInvalidation.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/student-bindings/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/writing-assignment-transfer/page.tsx", import.meta.url), "utf8")
  ]);
  assert.match(invalidation, /TEACHER_BINDING_UPDATED/);
  assert.match(bindingsRoute, /teacher_student_bindings/);
  assert.match(transferPage, /AdminOnly/);
  assert.match(transferPage, /WritingAssignmentTransfer/);
  assert.doesNotMatch(transferPage, /Teacher Bindings/);
});
