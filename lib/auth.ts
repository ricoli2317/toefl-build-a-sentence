import { createAnonSupabase } from "@/lib/supabase/server";
import type { StudentPerformanceTrace } from "@/lib/studentPerformance.server";
import type { AppArea, UserRole } from "@/lib/types";
import {
  defaultRouteForRole,
  isUserRole,
  roleCanAccess
} from "@/lib/accountPermissions";

export { defaultRouteForRole, isUserRole, roleCanAccess } from "@/lib/accountPermissions";

export type AuthenticatedAccount = {
  error: string | null;
  userId: string | null;
  role: UserRole | null;
};

export async function requireAuthenticatedAccount(
  token: string | null,
  timing?: StudentPerformanceTrace
): Promise<AuthenticatedAccount> {
  if (!token) return { error: "Missing access token", userId: null, role: null };

  const anon = createAnonSupabase(token);
  const {
    data: { user },
    error: userError
  } = await measure(timing, "auth", "supabase_auth_get_user", () =>
    anon.auth.getUser(token)
  );
  if (userError || !user) {
    return { error: "Invalid session", userId: null, role: null };
  }

  const { data: profile, error: profileError } = await measure(
    timing,
    "database",
    "profiles_role",
    () => anon.from("profiles").select("role,is_active").eq("id", user.id).single()
  );
  if (profileError || !profile || profile.is_active === false || !isUserRole(profile.role)) {
    return { error: "Account configuration error", userId: null, role: null };
  }
  return { error: null, userId: user.id, role: profile.role };
}

export async function requireUserWithRole(
  token: string | null,
  role: AppArea,
  timing?: StudentPerformanceTrace
) {
  const account = await requireAuthenticatedAccount(token, timing);
  if (account.error || !account.userId || !account.role) return account;
  if (!roleCanAccess(account.role, role)) {
    return { error: "Unauthorized", userId: null, role: account.role };
  }
  return account;
}

export async function requireAdmin(token: string | null) {
  const account = await requireAuthenticatedAccount(token);
  if (account.error || account.role !== "admin") {
    return { error: account.error ?? "Unauthorized", userId: null, role: account.role };
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
