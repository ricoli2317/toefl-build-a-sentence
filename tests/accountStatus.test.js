import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_BAN_DURATION,
  loadManagedAccountStatus,
  setManagedAccountActive
} from "../lib/accountStatus.server.ts";
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

function baseTables() {
  return {
    profiles: [
      { id: "student-1", role: "student", is_active: true },
      { id: "teacher-1", role: "teacher", is_active: true },
      { id: "admin-1", role: "admin", is_active: true }
    ],
    teacher_student_bindings: [
      { binding_id: "b1", teacher_id: "teacher-1", student_id: "student-1", domain: "reading" }
    ],
    attempts: [{ attempt_id: "att-1", student_id: "student-1" }]
  };
}

test("disable: profile gate flips first and the Auth user is banned, nothing is deleted", async () => {
  const { db, authCalls, tables } = createDb(baseTables());
  const loaded = await loadManagedAccountStatus(db, "student-1");
  assert.equal(loaded.ok, true);

  const result = await setManagedAccountActive(db, loaded.account, false);
  assert.deepEqual(result, { ok: true, isActive: false, banSynced: true });

  assert.equal(tables.profiles.find((row) => row.id === "student-1").is_active, false);
  assert.equal(authCalls.length, 1);
  assert.equal(authCalls[0].userId, "student-1");
  assert.equal(authCalls[0].attributes.ban_duration, ACCOUNT_BAN_DURATION);
  assert.equal(ACCOUNT_BAN_DURATION, "876000h");
  // Bindings and history rows stay untouched.
  assert.equal(tables.teacher_student_bindings.length, 1);
  assert.equal(tables.attempts.length, 1);
});

test("enable: the Auth ban is cleared and the profile gate reopens", async () => {
  const tables = baseTables();
  tables.profiles[0].is_active = false;
  const { db, authCalls } = createDb(tables);
  const loaded = await loadManagedAccountStatus(db, "student-1");
  assert.equal(loaded.account.isActive, false);

  const result = await setManagedAccountActive(db, loaded.account, true);
  assert.deepEqual(result, { ok: true, isActive: true, banSynced: true });

  assert.equal(tables.profiles.find((row) => row.id === "student-1").is_active, true);
  assert.equal(authCalls.length, 1);
  assert.equal(authCalls[0].attributes.ban_duration, "none");
});

test("disable: an Auth ban failure still leaves the account blocked and reported truthfully", async () => {
  const { db, tables } = createDb(baseTables(), {
    updateUserById: async () => ({ data: { user: null }, error: { message: "auth down" } })
  });
  const loaded = await loadManagedAccountStatus(db, "student-1");
  const result = await setManagedAccountActive(db, loaded.account, false);
  assert.deepEqual(result, { ok: true, isActive: false, banSynced: false });
  assert.equal(tables.profiles.find((row) => row.id === "student-1").is_active, false);
});

test("enable: an unban failure changes nothing and reports failure", async () => {
  const tables = baseTables();
  tables.profiles[0].is_active = false;
  const { db } = createDb(tables, {
    updateUserById: async () => ({ data: { user: null }, error: { message: "auth down" } })
  });
  const loaded = await loadManagedAccountStatus(db, "student-1");
  const result = await setManagedAccountActive(db, loaded.account, true);
  assert.equal(result.ok, false);
  assert.equal(tables.profiles.find((row) => row.id === "student-1").is_active, false);
});

test("load: Admin accounts are never a valid target; teachers are", async () => {
  const { db } = createDb(baseTables());
  const admin = await loadManagedAccountStatus(db, "admin-1");
  assert.equal(admin.ok, false);

  const teacher = await loadManagedAccountStatus(db, "teacher-1");
  assert.equal(teacher.ok, true);
  assert.equal(teacher.account.role, "teacher");

  const missing = await loadManagedAccountStatus(db, "ghost");
  assert.equal(missing.ok, false);
});
