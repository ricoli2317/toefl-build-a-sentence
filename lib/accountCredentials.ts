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
  return describeAccountFailure(classifyLoginError({ message: rawMessage }).code);
}

export type AccountFailureCode =
  | "LOGIN_NETWORK_ERROR"
  | "LOGIN_RATE_LIMITED"
  | "LOGIN_INVALID_CREDENTIALS"
  | "LOGIN_SERVICE_UNAVAILABLE"
  | "LOGIN_FAILED"
  | "ACCOUNT_UNAUTHENTICATED"
  | "ACCOUNT_VERIFICATION_UNAVAILABLE"
  | "ACCOUNT_VERIFICATION_FAILED"
  | "ACCOUNT_DISABLED"
  | "ACCOUNT_CONFIGURATION_ERROR"
  | "ACCOUNT_ACCESS_DENIED";

export type AccountFailureStage =
  | "password_sign_in"
  | "session_lookup"
  | "account_verification"
  | "identity_verification"
  | "profile_lookup";

export type AccountFailure = {
  code: AccountFailureCode;
  stage: AccountFailureStage;
  status: number | null;
  errorType: string;
  errorCode: string | null;
};

// Never forward arbitrary SDK names/codes/messages: even an Error can contain
// credentials or response bodies. Diagnostics are a fixed, primitive allowlist.
const SAFE_ERROR_TYPES = new Set([
  "Error", "TypeError", "AbortError", "TimeoutError", "AuthError", "AuthApiError",
  "AuthRetryableFetchError", "AuthUnknownError", "AuthInvalidJwtError",
  "AuthSessionMissingError", "AuthInvalidCredentialsError", "AuthInvalidTokenResponseError",
  "PostgrestError", "InvalidAccountResponse"
]);
const SAFE_ERROR_CODES = new Set([
  "invalid_credentials", "validation_failed", "user_banned", "user_disabled",
  "over_request_rate_limit", "over_email_send_rate_limit", "request_timeout",
  "unexpected_failure", "bad_jwt", "session_not_found", "session_expired",
  "refresh_token_not_found", "refresh_token_already_used", "user_not_found",
  "PGRST000", "PGRST001", "PGRST002", "PGRST003", "PGRST116",
  "PGRST301", "PGRST302", "PGRST303", "PGRST205",
  "08000", "08003", "08006", "53300", "53400", "57014", "57P01"
]);

export function accountErrorFields(error: unknown) {
  const value = error && typeof error === "object"
    ? error as { name?: unknown; code?: unknown; status?: unknown; message?: unknown }
    : {};
  return {
    name: typeof value.name === "string" ? value.name : "",
    code: typeof value.code === "string" ? value.code : "",
    status: accountHttpStatus(value.status),
    message: typeof value.message === "string" ? value.message : ""
  };
}

export function accountHttpStatus(status: unknown): number | null {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

export function accountFailure(
  code: AccountFailureCode,
  stage: AccountFailureStage,
  error?: unknown,
  status?: number | null
): AccountFailure {
  const fields = accountErrorFields(error);
  return {
    code,
    stage,
    status: status === undefined ? fields.status : accountHttpStatus(status),
    errorType: SAFE_ERROR_TYPES.has(fields.name) ? fields.name : "UnknownError",
    errorCode: SAFE_ERROR_CODES.has(fields.code) ? fields.code : null
  };
}

export function isAccountNetworkError(error: unknown) {
  const fields = accountErrorFields(error);
  return fields.name === "AuthRetryableFetchError" || fields.name === "AbortError"
    || fields.name === "TimeoutError"
    || /^(?:TypeError:\s*)?(?:Load failed|Failed to fetch|fetch failed|Network request failed|NetworkError(?: when attempting to fetch resource\.)?)$/i.test(fields.message);
}

export function classifyLoginError(error: unknown): AccountFailure {
  const fields = accountErrorFields(error);
  let code: AccountFailureCode = "LOGIN_FAILED";
  if (fields.status === 429) code = "LOGIN_RATE_LIMITED";
  else if (fields.status !== null && fields.status >= 500) code = "LOGIN_SERVICE_UNAVAILABLE";
  else if (fields.code === "user_banned" || /\bbanned\b/i.test(fields.message)) code = "ACCOUNT_DISABLED";
  else if (fields.code === "invalid_credentials" || /invalid login credentials/i.test(fields.message)) code = "LOGIN_INVALID_CREDENTIALS";
  else if (isAccountNetworkError(error)) code = "LOGIN_NETWORK_ERROR";
  return accountFailure(code, "password_sign_in", error);
}

export function describeAccountFailure(code: AccountFailureCode) {
  switch (code) {
    case "LOGIN_NETWORK_ERROR": return "网络连接失败，请检查网络后重试。";
    case "LOGIN_RATE_LIMITED": return "登录请求过于频繁，请稍后重试。";
    case "LOGIN_INVALID_CREDENTIALS": return "账号或密码错误，请检查后重试。";
    case "LOGIN_SERVICE_UNAVAILABLE": return "登录服务暂时不可用，请稍后重试。";
    case "ACCOUNT_UNAUTHENTICATED": return "登录状态已失效，请重新登录。";
    case "ACCOUNT_VERIFICATION_UNAVAILABLE": return "暂时无法验证账号，请检查网络或稍后重试。";
    case "ACCOUNT_VERIFICATION_FAILED": return "账号验证未能完成，请重试；如持续失败，请联系管理员。";
    case "ACCOUNT_DISABLED": return "账号已停用，请联系管理员。";
    case "ACCOUNT_CONFIGURATION_ERROR": return "账号配置异常，请联系管理员。";
    case "ACCOUNT_ACCESS_DENIED": return "当前账号无权访问此页面。";
    default: return "登录失败，请重试；如持续失败，请联系管理员。";
  }
}

/** Public, non-identifying feedback code: stage + category + observed HTTP status. */
export function accountDiagnosticCode(failure: AccountFailure) {
  const stages: Record<AccountFailureStage, string> = {
    password_sign_in: "PW",
    session_lookup: "SS",
    account_verification: "AV",
    identity_verification: "ID",
    profile_lookup: "PF"
  };
  const categories: Record<AccountFailureCode, string> = {
    LOGIN_NETWORK_ERROR: "NET",
    LOGIN_RATE_LIMITED: "RATE",
    LOGIN_INVALID_CREDENTIALS: "CRED",
    LOGIN_SERVICE_UNAVAILABLE: "AUTH",
    LOGIN_FAILED: "LOGIN",
    ACCOUNT_UNAUTHENTICATED: "SESSION",
    ACCOUNT_VERIFICATION_UNAVAILABLE: "VERIFY",
    ACCOUNT_VERIFICATION_FAILED: "CHECK",
    ACCOUNT_DISABLED: "OFF",
    ACCOUNT_CONFIGURATION_ERROR: "CONFIG",
    ACCOUNT_ACCESS_DENIED: "DENY"
  };
  return `TPS-${stages[failure.stage] ?? "UNKNOWN"}-${categories[failure.code] ?? "UNKNOWN"}-${accountHttpStatus(failure.status) ?? "NA"}`;
}

export function reportAccountFailure(failure: AccountFailure) {
  // Reconstruct rather than logging the supplied object, which may have extras.
  const safe = accountFailure(failure.code, failure.stage, {
    name: failure.errorType,
    code: failure.errorCode
  }, failure.status);
  console.warn("[account-auth]", safe);
}

export function describeForgotPasswordError(rawMessage: string | null | undefined) {
  const message = rawMessage ?? "";
  if (/[\u3400-\u9fff]/.test(message)) return message;
  return "请求提交失败，请稍后重试。";
}

/**
 * Success message for a submitted forgot-password request, keyed by the
 * account role the server actually resolved (never guessed from the account
 * string on the client).
 */
export function passwordResetWaitingMessage(role: string | null | undefined) {
  return role === "teacher" ? "请等待管理员许可" : "请等待教师许可";
}
