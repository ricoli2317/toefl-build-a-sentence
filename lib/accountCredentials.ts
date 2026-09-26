/**
 * Client-safe account credential helpers (no Supabase client, no secrets):
 * password-change validation and user-facing Auth error text.
 */

export const MIN_PASSWORD_LENGTH = 6;

export type PasswordChangeInput = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

export type PasswordChangeValidation =
  | { ok: true; currentPassword: string; newPassword: string }
  | { ok: false; message: string };

export function validatePasswordChangeInput(
  input: PasswordChangeInput
): PasswordChangeValidation {
  const currentPassword = input.currentPassword;
  const newPassword = input.newPassword;
  const confirmPassword = input.confirmPassword;

  if (!currentPassword) return { ok: false, message: "请输入当前密码。" };
  if (!newPassword) return { ok: false, message: "请输入新密码。" };
  if (!confirmPassword) return { ok: false, message: "请再次输入新密码。" };
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `新密码至少需要 ${MIN_PASSWORD_LENGTH} 位。` };
  }
  if (newPassword !== confirmPassword) {
    return { ok: false, message: "两次输入的新密码不一致。" };
  }
  if (newPassword === currentPassword) {
    return { ok: false, message: "新密码不能与当前密码相同。" };
  }
  return { ok: true, currentPassword, newPassword };
}

/**
 * Maps raw Supabase Auth errors from signInWithPassword / updateUser to the
 * short Chinese messages used by the change-password dialog.
 */
export function describePasswordChangeError(rawMessage: string | null | undefined) {
  const message = rawMessage ?? "";
  if (/invalid login credentials/i.test(message)) return "当前密码不正确。";
  if (/new password should be different/i.test(message)) return "新密码不能与当前密码相同。";
  if (/password should be at least|password is too short/i.test(message)) {
    return `新密码至少需要 ${MIN_PASSWORD_LENGTH} 位。`;
  }
  if (/banned/i.test(message)) return "账号已停用，请联系管理员。";
  if (/session|jwt|refresh token|not authenticated/i.test(message)) {
    return "登录状态已失效，请重新登录。";
  }
  return "密码修改失败，请稍后重试。";
}

export function describeLoginErrorMessage(rawMessage: string | null | undefined) {
  const message = rawMessage ?? "";
  if (/banned/i.test(message)) return "账号已停用，请联系管理员。";
  return message || "登录失败，请稍后重试。";
}

export function describeForgotPasswordError(rawMessage: string | null | undefined) {
  const message = rawMessage ?? "";
  if (/[\u3400-\u9fff]/.test(message)) return message;
  return "请求提交失败，请稍后重试。";
}
