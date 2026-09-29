import { createAnonSupabase } from "@/lib/supabase/server";
import { getCachedSupabaseJwks } from "@/lib/supabase/jwks.server";
import type { StudentPerformanceTrace } from "@/lib/studentPerformance.server";
import type { AppArea, UserRole } from "@/lib/types";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import {
  defaultRouteForRole,
  isUserRole,
  roleCanAccess
} from "@/lib/accountPermissions";

export {
  canUseStudentExperience,
  defaultRouteForRole,
  isUserRole,
  roleCanAccess
} from "@/lib/accountPermissions";

export type AuthenticatedAccountErrorCode = "ACCOUNT_DISABLED" | null;

export type AuthenticatedAccount = {
  error: string | null;
  errorCode: AuthenticatedAccountErrorCode;
  userId: string | null;
  role: UserRole | null;
  displayName: string | null;
};

type AccountAuthorization =
  | {
      ok: true;
      role: UserRole;
      displayName: string | null;
    }
  | {
      ok: false;
      error: string;
      errorCode: AuthenticatedAccountErrorCode;
    };

/**
 * Stage 1 of the split auth flow: verify the Supabase access token locally
 * against the cached JWKS and return the trusted `sub`.
 *
 * No profile/database read happens here, and callers must not use a claimed
 * user id before this resolves successfully. The catalog first-screen APIs use
 * this so the database profile read can run in parallel with their data reads.
 */
export async function verifyAuthenticatedIdentity(
  token: string | null,
  timing?: StudentPerformanceTrace,
  performanceNames?: { auth?: string }
): Promise<{ error: string | null; userId: string | null }> {
  if (!token) {
    return { error: "Missing access token", userId: null };
  }

  const anon = createAnonSupabase(token);
  const jwks = await getCachedSupabaseJwks();
  const {
    data: claimsData,
    error: claimsError
  } = await measure(timing, "auth", performanceNames?.auth ?? "supabase_auth_get_claims", () =>
    anon.auth.getClaims(token, jwks ? { jwks } : undefined)
  );
  const userId = typeof claimsData?.claims.sub === "string"
    ? claimsData.claims.sub
    : null;
  if (claimsError || !userId) {
    return { error: "Invalid session", userId: null };
  }
  return { error: null, userId };
}

/**
 * Shared per-request database authorization read: `role` and `is_active` always
 * come from the profiles row, read with the user's own token (RLS owner-read
 * policy) on every request. No profile value is cached across requests, so an
 * Admin disable takes effect on the very next request.
 *
 * `select` controls which profile columns are read. The catalog first-screen
 * APIs only need `role,is_active`; `requireAuthenticatedAccount` additionally
 * needs display-name fields for the account endpoint.
 */
async function loadAccountAuthorization<
  TProfile extends { role: unknown; is_active: boolean | null }
>(input: {
  token: string;
  userId: string;
  select: string;
  timing?: StudentPerformanceTrace;
  performanceName?: string;
}): Promise<AccountAuthorization> {
  const anon = createAnonSupabase(input.token);
  const { data: profile, error: profileError } = await measure(
    input.timing,
    "database",
    input.performanceName ?? "profiles_role",
    () => anon
      .from("profiles")
      .select(input.select)
      .eq("id", input.userId)
      .single() as unknown as PromiseLike<{
        data: TProfile | null;
        error: { message: string } | null;
      }>
  );
  if (profileError || !profile || !isUserRole(profile.role)) {
    return { ok: false, error: "Account configuration error", errorCode: null };
  }
  if (profile.is_active === false) {
    // The account still has valid Auth credentials in some cases (for example
    // after an Admin disable that could not sync the Auth ban); the app-level
    // gate rejects it here on every request.
    return { ok: false, error: "Account disabled", errorCode: "ACCOUNT_DISABLED" };
  }
  const displayName = "full_name" in profile
    ? getPreferredUserDisplayName({
        email: optionalProfileText(profile, "email"),
        profileFullName: optionalProfileText(profile, "full_name")
      })
    : null;
  return { ok: true, role: profile.role, displayName };
}

function optionalProfileText(profile: object, key: string): string | null {
  const value = (profile as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

export async function requireAuthenticatedAccount(
  token: string | null,
  timing?: StudentPerformanceTrace,
  performanceNames?: { auth?: string; profile?: string }
): Promise<AuthenticatedAccount> {
  const identity = await verifyAuthenticatedIdentity(token, timing, performanceNames);
  if (identity.error || !identity.userId || !token) {
    return { error: identity.error ?? "Invalid session", errorCode: null, userId: null, role: null, displayName: null };
  }

  const authorization = await loadAccountAuthorization({
    token,
    userId: identity.userId,
    select: "role,is_active,full_name,email",
    timing,
    performanceName: performanceNames?.profile
  });
  if (!authorization.ok) {
    return {
      error: authorization.error,
      errorCode: authorization.errorCode,
      userId: null,
      role: null,
      displayName: null
    };
  }
  return {
    error: null,
    errorCode: null,
    userId: identity.userId,
    role: authorization.role,
    displayName: authorization.displayName
  };
}

export type StudentCatalogAuthorization =
  | { ok: true; role: UserRole }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Stage 2 for the three student first-screen catalog APIs: read the minimal
 * `role,is_active` profile for an already verified user id.
 *
 * A missing profile, a non-role value, and `is_active = false` all reject, so
 * the catalog gate is exactly as strict as `requireAuthenticatedAccount`. The
 * query deliberately selects only the two fields the gate needs; display name
 * and email stay out of the catalog hot path.
 *
 * The caller starts this in parallel with the catalog/state preloads but must
 * gate the response on it before returning any catalog or student data.
 */
export async function loadStudentCatalogAuthorization(
  token: string | null,
  userId: string | null,
  timing?: StudentPerformanceTrace,
  performanceNames?: { profile?: string }
): Promise<StudentCatalogAuthorization> {
  if (!token || !userId) {
    return { ok: false, status: 401, error: "Missing access token" };
  }
  const authorization = await loadAccountAuthorization({
    token,
    userId,
    select: "role,is_active",
    timing,
    performanceName: performanceNames?.profile
  });
  if (!authorization.ok) {
    return {
      ok: false,
      status: authorization.errorCode === "ACCOUNT_DISABLED" ? 403 : 401,
      error: authorization.error
    };
  }
  if (!roleCanAccess(authorization.role, "student")) {
    return { ok: false, status: 403, error: "Unauthorized" };
  }
  return { ok: true, role: authorization.role };
}

export async function requireUserWithRole(
  token: string | null,
  role: AppArea,
  timing?: StudentPerformanceTrace,
  performanceNames?: { auth?: string; profile?: string }
) {
  const account = await requireAuthenticatedAccount(token, timing, performanceNames);
  if (account.error || !account.userId || !account.role) return account;
  if (!roleCanAccess(account.role, role)) {
    return { error: "Unauthorized", userId: null, role: account.role, displayName: null };
  }
  return account;
}

/**
 * Teacher operational endpoints must be used by actual teachers only.
 * Admin is a platform manager and must not act through Teacher teaching
 * operations, so Admin (and Student) receive "Forbidden" here.
 */
export async function requireTeacherOnly(
  token: string | null,
  timing?: StudentPerformanceTrace,
  performanceNames?: { auth?: string; profile?: string }
) {
  const account = await requireAuthenticatedAccount(token, timing, performanceNames);
  if (account.error || !account.userId || !account.role) return account;
  if (account.role !== "teacher") {
    return { error: "Forbidden", userId: null, role: account.role, displayName: null };
  }
  return account;
}

export async function requireAdmin(token: string | null) {
  const account = await requireAuthenticatedAccount(token);
  if (account.error || account.role !== "admin") {
    return { error: account.error ?? "Unauthorized", userId: null, role: account.role, displayName: null };
  }
  return account;
}

function measure<T>(
  timing: StudentPerformanceTrace | undefined,
  layer: "auth" | "database",
  name: string,
  operation: () => PromiseLike<T>
): Promise<T> {
  return timing ? timing.measure(layer, name, operation) : Promise.resolve(operation());
}

export function bearerToken(request: Request) {
  const header = request.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
}
