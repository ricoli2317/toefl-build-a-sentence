import assert from "node:assert/strict";
import test from "node:test";
import {
  describeLoginErrorMessage,
  describePasswordChangeError,
  passwordResetWaitingMessage,
  validatePasswordChangeInput
} from "../lib/accountCredentials.ts";

test("password change validation accepts a matching pair", () => {
  const result = validatePasswordChangeInput({
    currentPassword: "old-pass-1",
    newPassword: "new-pass-2",
    confirmPassword: "new-pass-2"
  });
  assert.deepEqual(result, {
    ok: true,
    currentPassword: "old-pass-1",
    newPassword: "new-pass-2"
  });
});

test("password change validation rejects incomplete or mismatched input", () => {
  const cases = [
    [{ currentPassword: "", newPassword: "abcdef", confirmPassword: "abcdef" }, "请输入当前密码。"],
    [{ currentPassword: "old", newPassword: "", confirmPassword: "" }, "请输入新密码。"],
    [{ currentPassword: "old", newPassword: "abcdef", confirmPassword: "" }, "请再次输入新密码。"],
    [{ currentPassword: "old", newPassword: "123", confirmPassword: "123" }, "新密码至少需要 6 位。"],
    [{ currentPassword: "old", newPassword: "abcdef", confirmPassword: "abcdeg" }, "两次输入的新密码不一致。"],
    [{ currentPassword: "abcdef", newPassword: "abcdef", confirmPassword: "abcdef" }, "新密码不能与当前密码相同。"]
  ];
  for (const [input, message] of cases) {
    const result = validatePasswordChangeInput(input);
    assert.equal(result.ok, false);
    assert.equal(result.message, message);
  }
});

test("Auth error messages map to short user-facing text", () => {
  assert.equal(describePasswordChangeError("Invalid login credentials"), "当前密码不正确。");
  assert.equal(
    describePasswordChangeError("New password should be different from the old password."),
    "新密码不能与当前密码相同。"
  );
  assert.equal(
    describePasswordChangeError("Password should be at least 6 characters."),
    "新密码至少需要 6 位。"
  );
  assert.equal(describePasswordChangeError("User is banned"), "账号已停用，请联系管理员。");
  assert.equal(describePasswordChangeError("JWT expired"), "登录状态已失效，请重新登录。");
  assert.equal(describePasswordChangeError("boom"), "密码修改失败，请稍后重试。");
});

test("login error messages surface banned accounts", () => {
  assert.equal(describeLoginErrorMessage("User is banned"), "账号已停用，请联系管理员。");
  assert.equal(describeLoginErrorMessage("Invalid login credentials"), "Invalid login credentials");
});

test("forgot-password wait message follows the server-resolved account role", () => {
  assert.equal(passwordResetWaitingMessage("student"), "请等待教师许可");
  assert.equal(passwordResetWaitingMessage("teacher"), "请等待管理员许可");
  assert.equal(passwordResetWaitingMessage(null), "请等待教师许可");
  assert.equal(passwordResetWaitingMessage(undefined), "请等待教师许可");
});
