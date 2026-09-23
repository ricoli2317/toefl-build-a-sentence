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

export type AuthenticatedAccount = {
  error: string | null;
  userId: string | null;
  role: UserRole | null;
  displayName: string | null;
};

export async function requireAuthenticatedAccount(
  token: string | null,
  timing?: StudentPerformanceTrace,
  performanceNames?: { auth?: string; profile?: string }
): Promise<AuthenticatedAccount> {
  if (!token) return { error: "Missing access token", userId: null, role: null, displayName: null };

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
    return { error: "Invalid session", userId: null, role: null, displayName: null };
  }

  const { data: profile, error: profileError } = await measure(
    timing,
    "database",
    performanceNames?.profile ?? "profiles_role",
    () => anon.from("profiles").select("role,is_active,full_name,email").eq("id", userId).single()
  );
  if (profileError || !profile || profile.is_active === false || !isUserRole(profile.role)) {
    return { error: "Account configuration error", userId: null, role: null, displayName: null };
  }
  return {
    error: null,
    userId,
    role: profile.role,
    displayName: getPreferredUserDisplayName({
      email: profile.email,
      profileFullName: profile.full_name
    })
  };
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
