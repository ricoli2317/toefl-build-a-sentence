import { createAnonSupabase } from "@/lib/supabase/server";
import type { StudentPerformanceTrace } from "@/lib/studentPerformance.server";
import type { UserRole } from "@/lib/types";

export async function requireUserWithRole(
  token: string | null,
  role: UserRole,
  timing?: StudentPerformanceTrace
) {
  if (!token) {
    return { error: "Missing access token", userId: null };
  }

  const anon = createAnonSupabase(token);
  const {
    data: { user },
    error: userError
  } = await measure(timing, "auth", "supabase_auth_get_user", () =>
    anon.auth.getUser(token)
  );

  if (userError || !user) {
    return { error: "Invalid session", userId: null };
  }

  const { data: profile, error: profileError } = await measure(
    timing,
    "database",
    "profiles_role",
    () => anon.from("profiles").select("role").eq("id", user.id).single()
  );

  if (profileError || profile?.role !== role) {
    return { error: "Unauthorized", userId: null };
  }

  return { error: null, userId: user.id };
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
