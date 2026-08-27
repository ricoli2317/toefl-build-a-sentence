import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ADMIN_LOGIN_AUTH_EMAIL,
  formatAccountForDisplay,
  formatManagedAccountName,
  normalizeNewAccountInput,
  prepareNewAccount,
  resolveLoginAuthEmail
} from "../lib/accountIdentifier.ts";

test("short existing account resolves to the internal Auth email", () => {
  assert.equal(resolveLoginAuthEmail("chenkeyin"), "chenkeyin@bas.com");
  assert.equal(resolveLoginAuthEmail(" ChenKeyIn "), "chenkeyin@bas.com");
});

test("full existing login identifier remains compatible", () => {
  assert.equal(resolveLoginAuthEmail("chenkeyin@bas.com"), "chenkeyin@bas.com");
  assert.equal(resolveLoginAuthEmail(" student@test.com "), "student@test.com");
});

test("Admin alias is case-insensitive and keeps the existing Auth identity", () => {
  for (const alias of ["admin", "Admin", "ADMIN"]) {
    assert.equal(resolveLoginAuthEmail(alias), ADMIN_LOGIN_AUTH_EMAIL);
  }
  assert.equal(ADMIN_LOGIN_AUTH_EMAIL, "student@test.com");
});

test("new account is normalized and converted only after strict validation", () => {
  assert.deepEqual(prepareNewAccount("Teacher01"), {
    ok: true,
    account: "teacher01",
    authEmail: "teacher01@bas.com"
  });
  assert.equal(normalizeNewAccountInput(" Zhang01 "), "zhang01");
  assert.equal(
    prepareNewAccount("Zhang01").ok && prepareNewAccount("Zhang01").account,
    prepareNewAccount("zhang01").ok && prepareNewAccount("zhang01").account
  );
});

test("new account rejects full emails and every unsupported character class", () => {
  for (const value of [
    "teacher01@bas.com",
    "teacher 01",
    "学生01",
    "teacher_01",
    "teacher-01",
    "teacher.01",
    "teacher@01"
  ]) {
    assert.deepEqual(prepareNewAccount(value), {
      ok: false,
      error: "账号只能包含英文字母和数字。"
    });
  }
  assert.deepEqual(prepareNewAccount("   "), { ok: false, error: "请输入账号。" });
});

test("admin is reserved for ordinary account creation", () => {
  for (const value of ["admin", "Admin", "ADMIN"]) {
    assert.deepEqual(prepareNewAccount(value), { ok: false, error: "该账号不可使用。" });
  }
});

test("product account display hides the internal bas.com implementation", () => {
  assert.equal(formatAccountForDisplay("teacher01@bas.com"), "teacher01");
  assert.equal(formatAccountForDisplay("student@test.com"), "admin");
  assert.equal(formatAccountForDisplay("teacher@test.com"), "teacher");
  assert.equal(formatAccountForDisplay("legacy@example.com"), "legacy@example.com");
  assert.equal(formatManagedAccountName("student@test.com", "student@test.com"), "admin");
  assert.equal(formatManagedAccountName("teacher@test.com", "teacher@test.com"), "teacher");
  assert.equal(formatManagedAccountName("张老师", "teacher@test.com"), "张老师");
});

test("creation APIs and account UI use account only while preserving authorization", async () => {
  const [teacherApi, studentApi, login, accountApi, teacherForm, studentForm] = await Promise.all([
    readFile(new URL("../app/api/admin/teachers/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/teacher/students/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/LoginPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/account/me/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/teacher/TeacherAccounts.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/TeacherCreateStudent.tsx", import.meta.url), "utf8")
  ]);

  assert.match(teacherApi, /prepareNewAccount\(typeof body\.account/);
  assert.doesNotMatch(teacherApi, /typeof body\.email/);
  assert.match(teacherApi, /\.ilike\("email", authEmail\)/);
  assert.match(studentApi, /prepareNewAccount\(body\.account/);
  assert.doesNotMatch(studentApi, /body\.email/);
  assert.match(studentApi, /\.ilike\("email", authEmail\)/);
  assert.match(studentApi, /STUDENT_ACCOUNT_LIMIT_REACHED/);
  assert.match(studentApi, /owner_id: auth\.userId/);
  assert.match(login, /resolveLoginAuthEmail\(account\)/);
  assert.match(login, /autoComplete="username"/);
  assert.doesNotMatch(login, /type="email"|请输入邮箱账号/);
  assert.match(teacherForm, /prepareNewAccount\(account\)/);
  assert.match(studentForm, /prepareNewAccount\(account\)/);
  assert.doesNotMatch(`${teacherForm}\n${studentForm}`, /type="email"|邮箱地址/);
  assert.match(accountApi, /userId: account\.userId/);
  assert.match(accountApi, /role: account\.role/);
});
