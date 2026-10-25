import {
  accountErrorFields,
  accountFailure,
  isAccountNetworkError,
  type AccountFailure,
  type AccountFailureStage
} from "./accountCredentials.ts";
import { defaultRouteForRole, isUserRole } from "./accountPermissions.ts";
import type { UserRole } from "./types.ts";

export type VerifiedAccount = {
  userId: string;
  role: UserRole;
  displayName: string;
  defaultRoute: string;
};

export type AccountVerificationResult =
  | { ok: true; account: VerifiedAccount }
  | { ok: false; failure: AccountFailure };

const TEMPORARY_DATABASE_CODES = new Set([
  "PGRST000", "PGRST001", "PGRST002", "PGRST003",
  "08000", "08003", "08006", "53300", "53400", "57014", "57P01"
]);

/** Unknown failures must not be asserted to be bad credentials/profile data. */
export function classifyAccountVerificationError(
  error: unknown,
  stage: AccountFailureStage,
  status?: number | null
): AccountFailure {
  const fields = accountErrorFields(error);
  const httpStatus = status ?? fields.status;
  if (httpStatus === 429 || httpStatus === 408 || (httpStatus !== null && httpStatus >= 500)
    || TEMPORARY_DATABASE_CODES.has(fields.code) || isAccountNetworkError(error)) {
    return accountFailure("ACCOUNT_VERIFICATION_UNAVAILABLE", stage, error, httpStatus);
  }
  if (fields.code === "user_banned" || fields.code === "user_disabled") {
    return accountFailure("ACCOUNT_DISABLED", stage, error, httpStatus);
  }
  if (httpStatus === 401 || fields.name === "AuthSessionMissingError"
    || fields.name === "AuthInvalidJwtError"
    || ["bad_jwt", "session_not_found", "session_expired", "refresh_token_not_found",
      "refresh_token_already_used", "user_not_found", "PGRST301", "PGRST302", "PGRST303"].includes(fields.code)) {
    return accountFailure("ACCOUNT_UNAUTHENTICATED", stage, error, httpStatus);
  }
  return accountFailure("ACCOUNT_VERIFICATION_FAILED", stage, error, httpStatus);
}

export function accountFailureHttpStatus(failure: AccountFailure): 401 | 403 | 500 | 503 {
  switch (failure.code) {
    case "ACCOUNT_UNAUTHENTICATED": return 401;
    case "ACCOUNT_DISABLED":
    case "ACCOUNT_CONFIGURATION_ERROR":
    case "ACCOUNT_ACCESS_DENIED": return 403;
    case "ACCOUNT_VERIFICATION_UNAVAILABLE": return 503;
    default: return 500;
  }
}

/** One bounded verification GET; never retries a password/auth POST. */
export async function fetchVerifiedAccount(
  accessToken: string,
  expectedUserId: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<AccountVerificationResult> {
  const controller = new AbortController();
  let timedOut = false;
  let response: Response | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 15_000);
  try {
    response = await (options.fetchImpl ?? fetch)("/api/account/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal: controller.signal
    });
    // HTTP status takes precedence over a misleading/malformed error body.
    if (response.status === 429 || response.status === 408 || response.status >= 500) {
      return { ok: false, failure: accountFailure("ACCOUNT_VERIFICATION_UNAVAILABLE", "account_verification", undefined, response.status) };
    }
    let payload: Record<string, unknown>;
    try {
      const value: unknown = await response.json();
      payload = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
    } catch (error) {
      if (response.status !== 401 && response.status !== 403) throw error;
      payload = {};
    }
    if (!response.ok) {
      const code = response.status === 403 && payload.code === "ACCOUNT_DISABLED"
        ? "ACCOUNT_DISABLED"
        : response.status === 403 && payload.code === "ACCOUNT_CONFIGURATION_ERROR"
          ? "ACCOUNT_CONFIGURATION_ERROR"
          : response.status === 401 ? "ACCOUNT_UNAUTHENTICATED"
            : response.status === 403 ? "ACCOUNT_ACCESS_DENIED"
              : "ACCOUNT_VERIFICATION_FAILED";
      return { ok: false, failure: accountFailure(code, "account_verification", undefined, response.status) };
    }
    if (payload.userId !== expectedUserId || !isUserRole(payload.role)
      || payload.defaultRoute !== defaultRouteForRole(payload.role)) {
      return { ok: false, failure: accountFailure("ACCOUNT_VERIFICATION_UNAVAILABLE", "account_verification", { name: "InvalidAccountResponse" }, response.status) };
    }
    return {
      ok: true,
      account: {
        userId: expectedUserId,
        role: payload.role,
        defaultRoute: defaultRouteForRole(payload.role),
        displayName: typeof payload.displayName === "string" ? payload.displayName.trim() : ""
      }
    };
  } catch (error) {
    return {
      ok: false,
      failure: accountFailure("ACCOUNT_VERIFICATION_UNAVAILABLE", "account_verification",
        timedOut ? { name: "TimeoutError" } : error, response?.status ?? null)
    };
  } finally {
    clearTimeout(timer);
  }
}
